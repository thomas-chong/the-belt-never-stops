"""The floor manager: the rules ADK enforces between Jev (reflex) and Gemini (clerk + teacher).

Pure code, no model calls, so every rule here is unit-tested:

- lane_for():   the cascade. Jev confidence >= AUTO -> "auto" (Jev decides alone);
                ABSTAIN <= confidence < AUTO -> "gemini" (second look); below ABSTAIN -> "human".
                Thresholds are runtime-adjustable (GET/POST /api/thresholds).
- guard_tool(): the deterministic gate in front of a tool call Gemini proposes
                (file_claim / issue_refund). Uses Jev's verdict + the ClaimPacket fields.
- after_second_look(): what the floor does with Gemini's second-look verdict.
- HumanQueue:   held parcels and the decisions people make on them.
- Proposals:    teacher proposals; applied only when a person approves one.
- Gemini cost and the "Gemini skipped" savings estimate (from measured calls in this run).
"""

from __future__ import annotations

import difflib
import hashlib
import itertools
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

from belt import calibrate, engine, policy, reflex

# ── thresholds: the safety gate (per action) and the old single threshold ──
#
# The old gate had ONE number: confidence >= 0.80 -> Jev decides alone. That is not safe on its own: a
# confidently wrong "ship" goes straight to a customer. The gate below (gate_route) is defence in depth,
# all plain code, every rule unit-tested and named on every route event:
#   a. per-action bars: auto-ship needs more than auto-hold (hold is the safe action: a person looks);
#      return / refund never go auto (irreversible, money).
#   b. cross-question check: Jev also answers "damaged?" and "risk"; if they contradict the action
#      (ship but P(damaged) >= 0.50, or risk >= 1.2) -> no auto, however confident the action answer is.
#   c. risk tiers from context: fragile contents or a FRAGILE mark -> no auto-ship; high-value / hazard
#      contents (electronics, batteries) -> higher bars; FRAGILE mark vs. non-fragile declared contents
#      -> a person checks.
#   d. audit sampling (SafetyMonitor): a fixed share of auto parcels also gets a Gemini 2nd look in shadow.
#   f. drift alarm: audited auto-lane errors over the budget tighten the bars, then pause auto-ship.
#   e. the bars come from data: belt/calibrate.py + scripts/calibrate_gate.py write belt/calibration.json,
#      loaded here at start-up.

LEGACY = {"auto": 0.80, "abstain": 0.40}   # the old single-threshold gate, kept only for the comparison
AUTO_ACTIONS = ("ship", "retape", "hold")  # return / file_claim / refund never auto
NEVER_AUTO = ("return", "file_claim", "issue_refund")
DESIGN = {"abstain": 0.40, "ship": 0.90, "retape": 0.85, "hold": 0.50}   # by design, before calibration
FLOORS = {"ship": 0.80, "retape": 0.70, "hold": 0.40}   # calibration never sets a bar below these
CROSS_DAMAGED = 0.50       # action says intact but P(damaged) >= this -> escalate
CROSS_RISK = 1.20          # ... or risk score (0 none, 1 cosmetic, 2 severe) >= this
FRAGILE_RETAPE_BUMP = 0.10
HIGH_VALUE_BUMP = 0.05
TIGHTEN_STEP = 0.05
CALIBRATION_FILE = Path(__file__).resolve().parent / "calibration.json"

FRAGILE_WORDS = ("glass", "ceramic", "porcelain", "crystal", "mirror", "vase", "wine", "china", "pottery",
                 "teapot", "stoneware", "fragile")
HIGH_VALUE_WORDS = ("laptop", "phone", "smartphone", "tablet", "camera", "lens", "drone", "speaker", "headphone", "monitor",
                    "tv", "television", "oled", "lcd", "console", "watch", "jewel", "battery", "batteries",
                    "lithium", "power bank", "e-bike", "electronic")
ACCESSORY = re.compile(r"\b(case|cover|strap|stand|bag|sleeve|holder)s?\b")   # "phone case" is not a phone


def _load_calibration() -> tuple[dict[str, float], str, dict | None]:
    """Bars in force at start-up: belt/calibration.json when it exists, else the design values."""
    try:
        cal = json.loads(CALIBRATION_FILE.read_text())
        bars = {a: float(cal["in_force"][a]) for a in AUTO_ACTIONS}
        if all(0.0 <= v <= 1.0 for v in bars.values()):
            return ({"abstain": float(cal.get("abstain", DESIGN["abstain"])), **bars},
                    f"calibration ({cal.get('source', '?')}, n={cal.get('n', '?')}, alpha={cal.get('alpha')})", cal)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return dict(DESIGN), "design values (no belt/calibration.json)", None


DEFAULTS, THRESHOLD_SOURCE, CALIBRATION = _load_calibration()
_th_lock = threading.Lock()
THRESHOLDS: dict[str, float] = dict(DEFAULTS)


def thresholds() -> dict[str, float]:
    """The base bars. `auto` = the ship bar (the slider's right thumb; kept for the old API)."""
    with _th_lock:
        return {"auto": THRESHOLDS["ship"], **THRESHOLDS}


def set_thresholds(auto: Any = None, abstain: Any = None, ship: Any = None, retape: Any = None,
                   hold: Any = None) -> dict[str, float]:
    """Validate and set. 0 <= abstain <= every action bar <= 1. `auto` is an alias of `ship`.
    Raises ValueError on bad input and then changes nothing."""
    ship = ship if ship is not None else auto
    with _th_lock:
        new = dict(THRESHOLDS)
        for key, val in (("abstain", abstain), ("ship", ship), ("retape", retape), ("hold", hold)):
            if val is None:
                continue
            try:
                f = float(val)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{key} must be a number") from exc
            if not 0.0 <= f <= 1.0:
                raise ValueError(f"{key} must be between 0 and 1")
            new[key] = round(f, 3)
        if any(new["abstain"] > new[a] for a in AUTO_ACTIONS):
            raise ValueError("abstain must be <= every action bar (ship, retape, hold)")
        THRESHOLDS.update(new)
    return thresholds()


def reset_thresholds() -> None:
    with _th_lock:
        THRESHOLDS.clear()
        THRESHOLDS.update(DEFAULTS)


def lane_for(confidence: float, th: dict[str, float] | None = None) -> tuple[str, str]:
    """The OLD single-threshold cascade (one auto bar for every action). Kept for the comparison:
    the new gate is gate_route(). With no `th`, it uses the old values 0.80 / 0.40."""
    th = th or LEGACY
    c = float(confidence)
    if c >= th["auto"]:
        return "auto", f"confidence {c:.2f} >= auto {th['auto']:.2f}: Jev decides"
    if c >= th["abstain"]:
        return "gemini", f"confidence {c:.2f} in defer band [{th['abstain']:.2f}, {th['auto']:.2f}): second look"
    return "human", f"confidence {c:.2f} < desk bar {th['abstain']:.2f}: Jev unsure, a person decides"


def tier_of(declared: str | None, handling: str | None) -> dict:
    """Risk tier from context (declared contents + handling marks). Pure text rules, no model."""
    d = f" {(declared or '').lower()} "
    h = (handling or "").lower()
    fragile_words = [w for w in FRAGILE_WORDS if w in d]
    value_words = [w for w in HIGH_VALUE_WORDS if re.search(rf"\b{re.escape(w)}", d)]
    if value_words and ACCESSORY.search(d):
        value_words = []
    marked = "fragile" in h
    tier = "fragile" if (fragile_words or marked) else "high_value" if value_words else "standard"
    return {"tier": tier, "fragile_words": fragile_words, "value_words": value_words, "fragile_mark": marked,
            "mismatch": marked and not fragile_words}


def effective_bars(th: dict[str, float] | None = None, drift: dict | None = None) -> dict:
    """Base bars + the drift offset (ship / retape only; hold is the safe action and never tightens)."""
    th = th or thresholds()
    off = float((drift or {}).get("offset") or 0.0)
    out = {"abstain": th["abstain"], "hold": th["hold"]}
    for a in ("ship", "retape"):
        out[a] = round(min(0.99, th[a] + off), 3)
    out["paused"] = bool((drift or {}).get("paused"))
    return out


SEVERITY = {"auto": 0, "gemini": 1, "human": 2}


def gate_route(choice: str, confidence: float, damaged: float, risk: float, declared: str | None = "",
               handling: str | None = "", th: dict[str, float] | None = None, drift: dict | None = None) -> dict:
    """The safety gate. Every check runs; the most cautious lane any fired check asks for wins
    (human > gemini > auto), and `rule` names the first check that asked for it.

    Returns {lane, rule, reason, tier, bar, checks: [{rule, fired, lane, detail}], legacy_lane, legacy_reason}."""
    th = th or thresholds()
    eff = effective_bars(th, drift)
    c, dmg, rk = float(confidence), float(damaged or 0), float(risk or 0)
    choice = str(choice or "").lower()
    t = tier_of(declared, handling)
    bar = eff.get(choice)
    if bar is not None and t["tier"] == "high_value" and choice in ("ship", "retape"):
        bar = round(min(0.99, bar + HIGH_VALUE_BUMP), 3)
    if bar is not None and t["tier"] == "fragile" and choice == "retape":
        bar = round(min(0.99, bar + FRAGILE_RETAPE_BUMP), 3)
    intact = choice in ("ship", "retape")
    checks: list[dict] = []

    def check(rule: str, fired: bool, lane: str, detail: str) -> None:
        checks.append({"rule": rule, "fired": bool(fired), "lane": lane, "detail": detail})

    check("abstain_low_confidence", c < eff["abstain"], "human",
          f"confidence {c:.2f} {'<' if c < eff['abstain'] else '>='} desk bar {eff['abstain']:.2f}"
          + (" (Jev unsure)" if c < eff["abstain"] else ""))
    check("return_never_auto", choice in NEVER_AUTO, "gemini",
          f"{choice}: irreversible / money, never decided alone" if choice in NEVER_AUTO else f"{choice} may go auto")
    cross = intact and (dmg >= CROSS_DAMAGED or rk >= CROSS_RISK)
    check("cross_check_disagree", cross, "gemini",
          f"action {choice} but P(damaged) {dmg:.2f} (>= {CROSS_DAMAGED:.2f}?) / risk {rk:.2f} (>= {CROSS_RISK:.2f}?)")
    check("marks_vs_declared", intact and t["mismatch"], "human",
          "FRAGILE mark on the box but the declared contents are not fragile: a person checks"
          if t["mismatch"] else "marks and declared contents agree")
    check("fragile_no_auto_ship", choice == "ship" and t["tier"] == "fragile", "gemini",
          f"tier {t['tier']}: ship needs a second look" if t["tier"] == "fragile" else f"tier {t['tier']}")
    check("drift_paused", intact and eff["paused"], "gemini",
          "audit errors over budget: auto-ship / auto-retape paused" if eff["paused"] else "auto not paused")
    if bar is None:
        check("no_bar_for_action", True, "gemini", f"no auto bar for '{choice}'")
    else:
        check(f"below_{choice}_bar", c < bar, "gemini",
              f"confidence {c:.2f} {'<' if c < bar else '>='} {choice} bar {bar:.2f}"
              + (f" (tier {t['tier']})" if t["tier"] != "standard" else "")
              + (f" (drift +{float((drift or {}).get('offset') or 0):.2f})" if (drift or {}).get("offset") else ""))
    fired = [ch for ch in checks if ch["fired"]]
    if fired:
        worst = max(SEVERITY[ch["lane"]] for ch in fired)
        first = next(ch for ch in fired if SEVERITY[ch["lane"]] == worst)
        lane, rule, reason = first["lane"], first["rule"], first["detail"]
        if len(fired) > 1:
            reason += f" (+{len(fired) - 1} more check{'s' if len(fired) > 2 else ''})"
    else:
        lane, rule = "auto", f"auto_{choice}"
        reason = f"confidence {c:.2f} >= {choice} bar {bar:.2f}, every check passed: Jev decides"
    legacy_lane, legacy_reason = lane_for(c, LEGACY)
    return {"lane": lane, "rule": rule, "reason": reason, "tier": t["tier"], "bar": bar, "checks": checks,
            "legacy_lane": legacy_lane, "legacy_reason": legacy_reason}


def still_person_reason(side: dict | None, person: str | None, th: dict[str, float] | None = None,
                        drift: dict | None = None) -> str | None:
    """Why a re-judged parcel still goes to a person, in plain words (None when it leaves the desk).
    `side` is one re-judge answer with the gate's lane / rule (see server.teach_rejudge)."""
    if side is None:
        return "no answer from Jev, so a person decides"
    if side.get("lane") != "human":
        return None
    right = "right answer" if side.get("action") == person else f"wrong answer ({str(side.get('action')).upper()})"
    if side.get("rule") == "abstain_low_confidence":
        bar = effective_bars(th, drift)["abstain"]
        return f"{right}, but confidence {float(side['confidence']):.2f} is under the {bar:.2f} desk bar"
    if side.get("rule") == "marks_vs_declared":
        return f"{right}, but the box has a FRAGILE mark the declared contents do not explain"
    return f"{right}, but the gate ({side.get('rule')}) keeps it with a person"


SECOND_LOOK_ACTIONS = ("ship", "retape", "hold", "return")


def after_second_look(verdict: dict, jev_damaged: float) -> tuple[str, str]:
    """('gemini', why) when Gemini's verdict stands, ('human', why) when the floor sends it on."""
    action = str(verdict.get("action") or "").lower()
    if verdict.get("needs_human"):
        return "human", "second_look asked for a person"
    if action not in SECOND_LOOK_ACTIONS:
        return "human", f"second_look gave no valid action ({action or 'none'})"
    if action == "ship" and float(jev_damaged) >= reflex.CLAIM_ON_DAMAGE:
        return "human", f"Gemini says ship but Jev sees damage {float(jev_damaged):.2f}: they disagree"
    return "gemini", f"second_look: {action}"


# ── the tool-call guardrail ─────────────────────────────────────────────────

REFUND_LIMIT_USD = float(os.environ.get("BELT_REFUND_LIMIT_USD", "150"))
GUARDED_TOOLS = ("file_claim", "issue_refund")


def _unreadable(v: Any) -> bool:
    s = str(v or "").strip().upper()
    return not s or "UNREADABLE" in s


def guard_tool(tool: str, args: dict, verdict: dict | None, already_filed: bool,
               th: dict[str, float] | None = None) -> dict:
    """Allow or block a tool call Gemini proposed. First matching rule wins.

    `verdict` = Jev's answer for that parcel: {"choice", "confidence", "damaged"} (or None).
    Returns {"allowed", "rule", "evidence"}."""
    th = th or thresholds()
    v = verdict or {}
    evidence = {"tool": tool, "parcel_id": args.get("parcel_id"),
                "tracking": args.get("tracking"), "consignee_zip": args.get("consignee_zip"),
                "amount_usd": args.get("amount_usd"),
                "jev_choice": v.get("choice"), "jev_confidence": v.get("confidence"),
                "jev_damaged": v.get("damaged"), "auto_threshold": th["auto"],
                "claim_on_damage": reflex.CLAIM_ON_DAMAGE, "refund_limit_usd": REFUND_LIMIT_USD}

    def out(allowed: bool, rule: str) -> dict:
        return {"allowed": allowed, "rule": rule, "evidence": evidence}

    if tool not in GUARDED_TOOLS:
        return out(False, "unknown_tool")
    if not verdict:
        return out(False, "no_jev_verdict_for_parcel")
    if already_filed:
        return out(False, "duplicate_claim_for_parcel")
    if _unreadable(args.get("tracking")) or (tool == "file_claim" and _unreadable(args.get("consignee_zip"))):
        return out(False, "packet_unreadable")
    conf = float(v.get("confidence") or 0)
    damaged = float(v.get("damaged") or 0)
    if tool == "issue_refund" and v.get("choice") in ("ship", "retape") and conf >= th["auto"]:
        return out(False, "jev_says_intact")
    if damaged < reflex.CLAIM_ON_DAMAGE:
        return out(False, "jev_sees_no_damage")
    if tool == "issue_refund":
        try:
            amount = float(args.get("amount_usd") or 0)
        except (TypeError, ValueError):
            return out(False, "refund_amount_invalid")
        if amount > REFUND_LIMIT_USD:
            return out(False, "refund_over_limit_needs_human")
    return out(True, "jev_damaged_and_packet_readable")


# ── people: the human lane ──────────────────────────────────────────────────

HUMAN_ACTIONS = ("ship", "retape", "hold", "return")


class HumanQueue:
    """Held parcels. Kept after a run ends, so people (and the teacher) can work through them."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.items: dict[str, dict] = {}

    def reset(self) -> None:
        with self._lock:
            self.items.clear()

    def add(self, parcel_id: str, reason: str, **info: Any) -> dict:
        with self._lock:
            item = {"parcel_id": parcel_id, "reason": reason, "status": "pending", "queued_at": time.time(),
                    "action": None, "decided_at": None, **info}
            self.items[parcel_id] = item
            return dict(item)

    def decide(self, parcel_id: str, action: str) -> dict:
        action = str(action or "").lower()
        if action not in HUMAN_ACTIONS:
            raise ValueError(f"action must be one of {list(HUMAN_ACTIONS)}")
        with self._lock:
            item = self.items.get(parcel_id)
            if item is None:
                raise KeyError(parcel_id)
            if item["status"] == "decided":
                raise ValueError(f"{parcel_id} was already decided ({item['action']})")
            item.update(status="decided", action=action, decided_at=time.time())
            return dict(item)

    def pending(self) -> list[dict]:
        with self._lock:
            return [dict(i) for i in self.items.values() if i["status"] == "pending"]

    def decided(self) -> list[dict]:
        with self._lock:
            return [dict(i) for i in self.items.values() if i["status"] == "decided"]

    def all(self) -> list[dict]:
        with self._lock:
            return [dict(i) for i in self.items.values()]


HUMAN = HumanQueue()


# ── teacher proposals ───────────────────────────────────────────────────────

_pids = itertools.count(1)
PROPOSALS: dict[str, dict] = {}


def policy_diff(before: dict[str, str], after: dict[str, str]) -> tuple[list[dict], str]:
    """[{option, before, after}] for changed options, plus a unified diff text."""
    rows, lines = [], []
    for key in policy.OPTIONS:
        a, b = before.get(key, ""), after.get(key, "")
        if a != b:
            rows.append({"option": key, "before": a, "after": b})
            lines += list(difflib.unified_diff([a], [b], fromfile=f"{key} (now)", tofile=f"{key} (proposed)",
                                               lineterm=""))
    return rows, "\n".join(lines)


_PARCEL_ID = re.compile(r"\(?\b(?:P|DEMO)-[A-Za-z0-9-]+\b\)?,?")
RULE_MAX_WORDS = 20


def strip_ids(text: str) -> str:
    """Policy text and the rule sentence are general rules: never a parcel id."""
    return " ".join(_PARCEL_ID.sub("", str(text or "")).split()).replace(" ,", ",").replace(" .", ".")


def plain_rule(text: str) -> str:
    """The teacher's one-sentence rule: no parcel ids, no "New rule:" prefix (the page adds it), <= 20 words."""
    t = strip_ids(text)
    t = re.sub(r"^\s*new rule\s*:\s*", "", t, flags=re.I).strip()
    words = t.split()
    if len(words) > RULE_MAX_WORDS:
        t = " ".join(words[:RULE_MAX_WORDS]).rstrip(",;:") + "."
    if t and t[-1] not in ".!?":
        t += "."
    return t[:1].upper() + t[1:] if t else t


# visible conditions an option can name; a stem the teacher ADDS to one option that another option also
# names is an overlap (probability splits between the two, confidence drops)
CONDITION_STEMS = ("dent", "scuff", "crush", "torn", "tear", "punctur", "wet", "leak", "stain", "crease",
                   "bulg", "hole", "rip", "flap", "tape", "open", "destroy")


def overlap_warnings(before: dict[str, str], after: dict[str, str]) -> list[str]:
    """Plain warnings when a changed option adds a condition word that another option also names.
    Words after a negation ("no dents", "without leaking") up to the next punctuation do not count."""
    def stems(t: str | None) -> set[str]:
        t = re.sub(r"\b(?:no|not|without|never)\b[^.,;:()]*", " ", (t or "").lower())
        return {s for s in CONDITION_STEMS if re.search(rf"\b{s}", t)}
    out = []
    for key in policy.OPTIONS:
        if after.get(key) == before.get(key):
            continue
        for s in sorted(stems(after.get(key)) - stems(before.get(key))):
            others = [o for o in policy.OPTIONS if o != key and s in stems(after.get(o))]
            if others:
                out.append(f"'{s}' added to {key} but also in {', '.join(others)}: the options overlap")
    return out


def evidence_for(parcel_ids: list[str]) -> list[dict]:
    """One row per cited parcel the desk decided: the photo, the declared contents, what the person chose.
    Cited ids the desk never decided are dropped; no cited id at all -> every decided parcel."""
    decided = {d["parcel_id"]: d for d in HUMAN.decided() if d.get("kind") != "audit"}
    ids = [i for i in parcel_ids if i in decided] or list(decided)
    return [{"parcel_id": i, "photo_url": decided[i].get("photo_url") or f"/api/photos/{i}.jpg",
             "declared": decided[i].get("declared"), "person_action": decided[i].get("action")} for i in ids]


def new_proposal(changes: list[dict], rationale: str, parcel_ids: list[str], live: bool,
                 call_id: str | None = None, rule_text: str = "") -> dict:
    """Validate a teacher proposal against the current policy. Never applies it.
    Raises ValueError for an unknown option or a text that is too long. A proposal that changes no words
    is kept with status "no_change" (the page says so and offers no Approve button)."""
    current = policy.current_options()
    merged = dict(current)
    for ch in changes or []:
        key = str((ch or {}).get("option") or "")
        text = (ch or {}).get("new_text")
        if key not in policy.OPTIONS:
            raise ValueError(f"teacher proposed an unknown option '{key}'")
        merged[key] = strip_ids(text) if isinstance(text, str) else text
    merged = policy.validate(merged)
    rows, text = policy_diff(current, merged)
    pid = f"T{next(_pids):03d}"
    ids = [str(p) for p in (parcel_ids or [])][:30]
    evidence = evidence_for(ids)
    prop = {"proposal_id": pid, "diff": rows, "diff_text": text, "rationale": str(rationale or "")[:1500],
            "parcel_ids": [e["parcel_id"] for e in evidence] or ids, "options": merged,
            "base_options": current, "rule_text": plain_rule(rule_text or re.split(r"(?<=[.!?])\s", str(rationale or ""))[0]) if rows else "",
            "evidence": evidence, "base_version": policy.version(),
            "status": "proposed" if rows else "no_change", "live": live, "call_id": call_id,
            "warnings": overlap_warnings(current, merged), "created_at": time.time()}
    PROPOSALS[pid] = prop
    return prop


def approve(proposal_id: str) -> dict:
    """A person approved: apply it. Returns the new public policy. Raises KeyError / ValueError."""
    prop = PROPOSALS.get(proposal_id)
    if prop is None:
        raise KeyError(proposal_id)
    if prop["status"] == "no_change":
        raise ValueError(f"proposal {proposal_id} changes nothing: the policy already matches the desk")
    if prop["status"] != "proposed":
        raise ValueError(f"proposal {proposal_id} is {prop['status']}")
    state = policy.apply(options=prop["options"], name=f"Teacher proposal {proposal_id} (approved)")
    prop.update(status="approved", approved_at=time.time(), applied_version=state["version"])
    return state


# ── Gemini cost and the "skipped" estimate ──────────────────────────────────

# Gemini 3.5 Flash-Lite, USD per 1M tokens, Standard paid tier: $0.30 input (text/image), $2.50 output
# including thinking tokens. Source: the published Gemini API price list, https://ai.google.dev/gemini-api/docs/pricing
# (read 2026-10-30). The Vertex AI price for this project was not checked separately: we assume it is the same.
# Override with env vars (and say so on stage) if the price changes.
GEMINI_PRICE_IN = float(os.environ.get("BELT_GEMINI_PRICE_IN", "0.30"))
GEMINI_PRICE_OUT = float(os.environ.get("BELT_GEMINI_PRICE_OUT", "2.50"))
GEMINI_PRICE_SOURCE = ("published Gemini API price for gemini-3.5-flash-lite (ai.google.dev/gemini-api/docs/pricing, "
                       "read 2026-10-30); Vertex price assumed equal"
                       if "BELT_GEMINI_PRICE_IN" not in os.environ and "BELT_GEMINI_PRICE_OUT" not in os.environ
                       else "assumed (set by BELT_GEMINI_PRICE_IN / BELT_GEMINI_PRICE_OUT)")
PRIOR_MS = 4000.0          # used only until this run has measured a live Gemini call
PRIOR_COST = 0.002


def gemini_cost(tokens_in: int | None, tokens_out: int | None, thought_tokens: int | None) -> float:
    return round(((tokens_in or 0) * GEMINI_PRICE_IN + ((tokens_out or 0) + (thought_tokens or 0)) * GEMINI_PRICE_OUT)
                 / 1_000_000, 7)


def skip_estimate(measured: list[dict]) -> dict:
    """What a skipped second look would have cost, from this run's live second_look calls.

    `measured` = [{"agent", "ms", "cost", "live"}]. Like with like: only live second_look calls (the
    same job) count; a label read or a report is a different job. Before the first one, a prior
    (and `basis` says which)."""
    pool = [m for m in measured if m.get("live") and m.get("ms") and m.get("agent") == "second_look"]
    if not pool:
        return {"saved_ms_est": PRIOR_MS, "saved_cost_est": PRIOR_COST,
                "basis": "prior (no live second_look call measured in this run yet)", "n": 0}
    ms = sum(float(m["ms"]) for m in pool) / len(pool)
    cost = sum(float(m.get("cost") or 0) for m in pool) / len(pool)
    return {"saved_ms_est": round(ms), "saved_cost_est": round(cost, 7),
            "basis": f"estimate: mean of {len(pool)} live second_look call(s) in this run", "n": len(pool)}


# ── audit sampling + drift alarm (defence in depth, parts d and f) ──────────

def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


SAFETY_CONFIG: dict[str, float] = {
    "audit_rate": _env_float("BELT_AUDIT_RATE", 0.10),   # share of auto-lane parcels audited in shadow
    "alpha": _env_float("BELT_ALPHA", 0.02),             # error budget of the auto lane
}
AUDIT_LABEL_SOURCE = "answer key (stands in for the human auditor in this demo)"


def set_safety_config(audit_rate: Any = None, alpha: Any = None) -> dict:
    new = dict(SAFETY_CONFIG)
    for key, val in (("audit_rate", audit_rate), ("alpha", alpha)):
        if val is None:
            continue
        try:
            f = float(val)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{key} must be a number") from exc
        if not 0.0 <= f <= 1.0:
            raise ValueError(f"{key} must be between 0 and 1")
        new[key] = round(f, 4)
    SAFETY_CONFIG.update(new)
    return dict(SAFETY_CONFIG)


def audit_pick(parcel_id: str, seed: str, rate: float) -> bool:
    """Deterministic for a (seed, parcel) pair, uniform over parcels: the same run seed audits the
    same parcels, a new run seed audits a fresh random sample."""
    if rate <= 0:
        return False
    h = int(hashlib.sha256(f"{seed}:{parcel_id}".encode()).hexdigest()[:12], 16) / float(16 ** 12)
    return h < rate


def _same(a: str | None, b: str | None) -> bool:
    norm = lambda x: "ship" if x == "spot_check" else (x or "")  # noqa: E731
    return norm(a) == norm(b)


class SafetyMonitor:
    """One per run (reset by the workflow's enter node). Counts rules, keeps the audit sample, and
    tightens the gate when audited auto-lane mistakes go over the budget (alpha)."""

    def __init__(self, seed: str | None = None) -> None:
        self._lock = threading.Lock()
        self.reset(seed)

    def reset(self, seed: str | None = None) -> None:
        with getattr(self, "_lock", threading.Lock()):
            self.seed = seed or os.environ.get("BELT_AUDIT_SEED") or f"{time.time():.6f}"
            self.rules: dict[str, int] = {}
            self.routes: dict[str, dict] = {}           # parcel -> gate result (+ final lane)
            self.audits: dict[str, dict] = {}           # parcel -> audit record
            self.level = 0                              # 0 normal, 1 tightened, 2 auto paused
            self.offset = 0.0
            self.breaches = 0
            self.history: list[dict] = []
            self.auto_key: dict[str, dict] = {}         # demo only: every auto parcel graded by the key

    # drift state as the gate reads it
    def drift(self) -> dict:
        return {"level": self.level, "state": ("normal", "tightened", "paused")[self.level],
                "offset": round(self.offset, 3), "paused": self.level >= 2}

    def note_route(self, parcel_id: str, result: dict) -> None:
        with self._lock:
            self.routes[parcel_id] = result
            self.rules[result["rule"]] = self.rules.get(result["rule"], 0) + 1

    def note_auto(self, parcel_id: str, action: str, truth: str | None) -> None:
        """Demo only: the answer key grades every auto decision. Production never has this."""
        if truth is None:
            return
        with self._lock:
            self.auto_key[parcel_id] = {"action": action, "truth": truth,
                                        "error": engine.grade({"action": truth}, action) in ("wrong", "near_miss")}

    def wants_audit(self, parcel_id: str) -> bool:
        return audit_pick(parcel_id, self.seed, SAFETY_CONFIG["audit_rate"])

    def start_audit(self, parcel_id: str, auto_action: str) -> dict:
        with self._lock:
            rec = {"parcel_id": parcel_id, "auto_action": auto_action, "status": "running",
                   "started_at": time.time()}
            self.audits[parcel_id] = rec
            return dict(rec)

    def finish_audit(self, parcel_id: str, verdict: dict, truth: str | None) -> tuple[dict, dict | None]:
        """Gemini's shadow verdict is in. Returns (audit record, drift change or None)."""
        with self._lock:
            rec = self.audits.setdefault(parcel_id, {"parcel_id": parcel_id, "auto_action": None})
            g = str((verdict or {}).get("action") or "")
            flagged = bool((verdict or {}).get("needs_human")) or not _same(g, rec.get("auto_action"))
            rec.update(status="done", gemini_action=g or None, gemini_reason=(verdict or {}).get("reason"),
                       needs_human=bool((verdict or {}).get("needs_human")), flagged=flagged,
                       label=truth, label_source=AUDIT_LABEL_SOURCE if truth else None,
                       finished_at=time.time())
            rec["error"] = bool(truth) and engine.grade({"action": truth}, rec["auto_action"]) in ("wrong", "near_miss")
            change = self._check_drift_locked(parcel_id)
            return dict(rec), change

    def relabel(self, parcel_id: str, action: str) -> tuple[dict | None, dict | None]:
        """A person reviewed an audited parcel: their answer is the audit label from now on."""
        with self._lock:
            rec = self.audits.get(parcel_id)
            if rec is None:
                return None, None
            rec.update(label=action, label_source="person",
                       error=engine.grade({"action": action}, rec.get("auto_action") or "") in ("wrong", "near_miss"))
            return dict(rec), self._check_drift_locked(parcel_id)

    def _check_drift_locked(self, parcel_id: str) -> dict | None:
        """Over budget -> tighten (bars +0.05), and if it happens again -> pause auto-ship / auto-retape.
        Never relaxes by itself: a person resets it (POST /api/safety {reset_drift: true})."""
        done = [a for a in self.audits.values() if a.get("status") == "done"]
        n = len(done)
        errors = sum(1 for a in done if a.get("error"))
        alpha = SAFETY_CONFIG["alpha"]
        if errors <= self.breaches or errors <= alpha * n:
            return None
        self.breaches = errors
        self.level = min(2, self.level + 1)
        self.offset = TIGHTEN_STEP if self.level >= 1 else 0.0
        ev = {"ts": round(time.time(), 3), "level": self.level, "state": self.drift()["state"],
              "offset": self.offset, "errors": errors, "n": n, "alpha": alpha, "parcel_id": parcel_id,
              "reason": (f"{errors} audited auto-lane mistake{'s' if errors != 1 else ''} in {n} audits "
                         f"> budget {alpha:.0%} x {n} = {alpha * n:.2f}: "
                         + ("bars +0.05" if self.level == 1 else "auto-ship and auto-retape paused"))}
        self.history.append(ev)
        return ev

    def reset_drift(self) -> dict:
        with self._lock:
            self.level, self.offset, self.breaches = 0, 0.0, sum(
                1 for a in self.audits.values() if a.get("error"))
            self.history.append({"ts": round(time.time(), 3), "level": 0, "state": "normal", "offset": 0.0,
                                 "reason": "reset by a person"})
            return self.drift()

    def stats(self) -> dict:
        with self._lock:
            done = [a for a in self.audits.values() if a.get("status") == "done"]
            n = len(done)
            errors = sum(1 for a in done if a.get("error"))
            keyed = list(self.auto_key.values())
            k_err = sum(1 for a in keyed if a["error"])
            return {
                "audit": {"rate": SAFETY_CONFIG["audit_rate"], "alpha": SAFETY_CONFIG["alpha"], "seed": self.seed,
                          "started": len(self.audits), "n": n,
                          "pending": sum(1 for a in self.audits.values() if a.get("status") != "done"),
                          "flagged": sum(1 for a in done if a.get("flagged")), "errors": errors,
                          "observed_error": round(errors / n, 4) if n else None,
                          "ucb95": calibrate.clopper_pearson_upper(errors, n), "label_source": AUDIT_LABEL_SOURCE},
                "drift": {**self.drift(), "history": list(self.history[-10:])},
                "rules": dict(self.rules),
                "auto_key": {"n": len(keyed), "errors": k_err,
                             "note": "demo only: the answer key checks every auto parcel; production sees only audits"},
            }

    def audit_list(self) -> list[dict]:
        with self._lock:
            return [dict(a) for a in self.audits.values()]


SAFETY = SafetyMonitor()


def safety_public() -> dict:
    """GET /api/safety: everything the Safety view shows."""
    th = thresholds()
    drift = SAFETY.drift()
    return {"thresholds": th, "effective": effective_bars(th, drift), "source": THRESHOLD_SOURCE,
            "defaults": dict(DEFAULTS), "design": dict(DESIGN), "floors": dict(FLOORS), "legacy": dict(LEGACY),
            "never_auto": list(NEVER_AUTO),
            "params": {"cross_damaged": CROSS_DAMAGED, "cross_risk": CROSS_RISK,
                       "fragile_retape_bump": FRAGILE_RETAPE_BUMP, "high_value_bump": HIGH_VALUE_BUMP,
                       "tighten_step": TIGHTEN_STEP, "fragile_words": list(FRAGILE_WORDS),
                       "high_value_words": list(HIGH_VALUE_WORDS)},
            "config": dict(SAFETY_CONFIG), **SAFETY.stats(), "audits": SAFETY.audit_list(),
            "routes": {k: {kk: v.get(kk) for kk in ("lane", "rule", "tier", "bar", "legacy_lane", "final_lane")}
                       for k, v in SAFETY.routes.items()},
            "calibration": {k: v for k, v in (CALIBRATION or {}).items() if k != "rows"} or None}
