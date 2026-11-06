"""The belt as one Google ADK Workflow (graph). Jev is the reflex, Gemini the clerk, ADK the floor manager.

  START ─► enter ─► tick (Jev 1.14, ~0.1 s) ─► gate (floor manager, code) ─► check_claim ─► tick ─► …
                                                 │
            lane "auto"  (confidence >= AUTO)    ├─ ctx.run_node(second_look): before_model_callback
            lane "human" (confidence < ABSTAIN)  │    SKIPS Gemini (gemini_skipped); Jev / a person decides
            lane "gemini" (defer band)           ├─► second_look_desk_N ─► ctx.run_node(second_look)
                                                 │      (Gemini looks at the same photo + Jev's probabilities;
                                                 │       verdict {action, reason, needs_human})
            Jev sees damage                      ├─► read_label ─► claims_clerk (Gemini, tools) ─► claim_ready
                                                 │        ▲  proposes file_claim / issue_refund;   │
                                                 │        │  before_tool_callback (code) allows    │
                                                 │        └──── or blocks it ── "retry" ───────────┘
                                                 └─ "done" ─► summarise ─► shift_lead (Gemini) ─► finish

Every Gemini call goes through ADK callbacks here: before_model_callback (skip, or record + replay),
after_model_callback (stream deltas, close the record with usage and cost), on_model_error_callback
(answer from the recording). The belt never waits for Gemini: second looks run on desks off the
main loop, label reads on their own branch. The teacher agent lives in belt/teach.py.

Two event streams leave this module:
- `Belt.emit`   the original page events (GET /api/events, belt/static), unchanged;
- `Belt.stream` the API contract events (GET /api/stream, the new front end; see belt/API.md).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import time
from typing import Any, Callable, Literal

from google.adk.agents import LlmAgent
from google.adk.agents.context import Context
from google.adk.events.event import Event
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.tool_context import ToolContext
from google.adk.workflow import FunctionNode, Workflow
from google.genai import types
from pydantic import BaseModel, Field

from belt import calls, engine, floor, jev, label, policy, reflex

# One model id for every Gemini agent (second_look, claims_clerk, shift_lead, teacher, gemini_reflex).
# gemini-3.5-flash-lite answered on Vertex AI in our project, location global (2026-10-30).
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
GEMINI_MODEL = os.environ.get("BELT_GEMINI_MODEL") or DEFAULT_GEMINI_MODEL
TICK_SECONDS = float(os.environ.get("BELT_TICK_SECONDS", "1.0"))   # belt pace, so people can watch
N_DESKS = int(os.environ.get("BELT_SECOND_LOOK_DESKS", "3"))     # second looks that can run at once
MAX_READS_PER_PARCEL = 2                                           # first read + one re-scan
REPLAY_GEMINI_SECONDS = lambda: float(os.environ.get("BELT_REPLAY_GEMINI_SECONDS", "3"))  # noqa: E731


def forced_replay() -> bool:
    return os.environ.get("BELT_REPLAY") == "1"


# Every Gemini call has a job. Only "decision" calls make the same kind of decision Jev makes, so only
# they are ever compared with Jev's decision latency / cost on screen.
JOBS = {"second_look": "decision", "gemini_reflex": "decision", "claims_clerk": "clerk",
        "shift_lead": "report", "teacher": "teacher"}
JOB_LABELS = {"second_look": "2nd look (decision on unsure parcels)",
              "gemini_reflex": "reflex (decision on every parcel, head-to-head)",
              "claims_clerk": "clerk (reads label -> claim)", "shift_lead": "report", "teacher": "teacher"}


def job_of(agent: str) -> str:
    return JOBS.get(agent, "other")


# ── walk mode + the caption bar (A6): one plain sentence per graph step ─────

WALK_PAUSE = lambda: float(os.environ.get("BELT_WALK_SECONDS", "2.5"))  # noqa: E731
WALK_MAX_WAIT = 90.0          # the belt never waits longer than this for the walked parcel


class WalkState:
    """Parcel 1 of a walk run: the steps it will visit, how far it got, and when it is done."""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self.pid: str | None = None
        self.k = 0                    # last step whose caption has been on screen for the full pause
        self.done = asyncio.Event()
        self.lock = asyncio.Lock()    # one walked caption at a time: parallel branches queue behind it
        if not enabled:
            self.done.set()

    def active(self, pid: str) -> bool:
        return self.enabled and self.pid == pid and not self.done.is_set()


def plan_steps(lane: str, claim: bool) -> int:
    """tick, gate, the lane's own step, and (when Jev sees damage) the label read and the tool gate."""
    return 3 + (2 if claim else 0)


def _num(v: Any) -> str:
    return f"{float(v or 0):.2f}"


def caption_gate(g: dict, confidence: float, choice: str) -> str:
    """Step 2 in plain words: why the gate picked this lane."""
    lane, rule = g.get("lane"), str(g.get("rule") or "")
    c = _num(confidence)
    if rule == "abstain_low_confidence":
        return f"{c} is under 0.40 → human desk, Gemini skipped"
    if lane == "auto":
        return f"{c} clears the {choice} bar {_num(g.get('bar'))} → auto, Gemini skipped"
    plain = {"marks_vs_declared": "FRAGILE mark, but the declared contents are not fragile",
             "fragile_no_auto_ship": "fragile parcels never ship without a person",
             "cross_check_disagree": "Jev's damage or risk score is high",
             "return_never_auto": "return and refund never go auto",
             "drift_paused": "auto is paused by the drift alarm"}.get(rule)
    to = "human desk, Gemini skipped" if lane == "human" else "second look by Gemini"
    if plain:
        return f"{plain} → {to}"
    if rule.startswith("below_") and g.get("bar") is not None:
        return f"{c} is under the {choice} bar {_num(g.get('bar'))} → {to}"
    return f"rule {rule} → {to}"


def caption_tool(tool: str, allowed: bool, rule: str, damaged: float | None) -> str:
    what = "refund" if tool == "issue_refund" else "claim"
    why = {"packet_unreadable": "the label is unreadable",
           "jev_sees_no_damage": f"damaged {_num(damaged)} is under 0.60",
           "jev_says_intact": "Jev says the box is fine",
           "duplicate_claim_for_parcel": "a claim is already filed",
           "refund_over_limit_needs_human": "the refund is over the limit",
           "jev_damaged_and_packet_readable": f"damaged {_num(damaged)}, label readable"}.get(rule, rule)
    return f"{what} proposed, {why} → {'ALLOWED' if allowed else 'BLOCKED'}"


# ── one run of the belt (keyed by ADK session id) ───────────────────────────

class Belt:
    def __init__(self, emit: Callable[[dict], None], mode: str, limit: int | None = None,
                 pace: float | None = None, stream: Callable[[dict], None] | None = None,
                 make_client: bool = True, seed: bool | str = False, parcels: list[dict] | None = None,
                 walk: bool = False):
        self.emit_raw = emit
        self.stream_raw = stream or (lambda event: None)
        # Seconds the belt waits between parcels, so people can watch. 0 = as fast as Jev answers.
        self.pace = TICK_SECONDS if pace is None else max(0.0, min(5.0, float(pace)))
        self.gem_calls: dict[str, dict] = {}   # agent -> last opened calls.py record (legacy page)
        self.mode = mode                       # "workflow" (Jev + Gemini, lanes) or "h2h" (Jev vs Gemini)
        # seed=True adds the seeded "confidently wrong" cases (photos/seeded/) after the real photos;
        # seed="only" runs just those.
        # `parcels` (a named set or an explicit id list, belt/sets.py) wins over `limit`.
        if parcels is not None:
            real = list(parcels)
        else:
            real = [] if seed == "only" else engine.parcels()[: limit or None]
        self.parcels = real + (engine.seeded_parcels() if seed and parcels is None else [])
        # walk=True (mode 3): parcel 1 walks the graph, WALK_PAUSE at each step; parcels 2..N run at pace
        self.walk = WalkState(enabled=bool(walk) and mode == "workflow")
        self.seed = seed
        self.by_id = {p["id"]: p for p in self.parcels}
        self.index = 0
        self.score = engine.Scorecard()
        self.labels_read = 0
        self.label: dict | None = None
        self.reading = False                   # True while claims_clerk has a label in flight
        self.t0 = time.perf_counter()
        self.jev = jev.client() if make_client else None
        # the floor
        self.verdicts: dict[str, dict] = {}    # parcel id -> Jev's answer + the gate's lane
        self.lanes = {"auto": 0, "gemini": 0, "human": 0}
        self.lane_of: dict[str, str] = {}
        self.skipped = 0
        self.saved_ms = 0.0
        self.saved_cost = 0.0
        self.gem_measured: list[dict] = []     # closed Gemini calls: agent, ms, cost, live
        self.gemini_cost = 0.0
        self.jev_cost = 0.0
        self.blocked_tools = 0
        self.allowed_tools = 0
        self.claims: dict[str, dict] = {}      # parcel id -> filed claim / refund
        self.reads_for: dict[str, int] = {}    # parcel id -> label reads so far
        self.pending_slow = 0                  # second looks + label reads not finished yet
        self.desk_load = [0] * N_DESKS
        self.last_llm_call: dict[str, str] = {}
        self.h2h_rows: list[dict] = []         # head-to-head mode (belt/h2h.py): one row per parcel
        self.auditing: set[str] = set()        # auto-lane parcels whose shadow 2nd look is running

    def now(self) -> float:
        return round(time.perf_counter() - self.t0, 3)

    def emit(self, event_type: str, /, **data: Any) -> None:
        self.emit_raw({"type": event_type, "t": self.now(), **data})

    def stream(self, event_type: str, /, **data: Any) -> None:
        self.stream_raw({"type": event_type, "ts": round(time.time(), 3), "t": self.now(), **data})

    def next_label(self, contents: str | None = None) -> dict:
        self.labels_read += 1
        self.label = label.new_label(self.labels_read, contents=contents)
        label.RECENT[self.labels_read] = self.label
        return self.label

    def gemini_jobs(self) -> dict:
        """Gemini calls split by job (belt/API.md): decision calls vs clerk / report / teacher work."""
        out: dict[str, dict] = {}
        for m in self.gem_measured:
            j = out.setdefault(job_of(m["agent"]), {"calls": 0, "live_calls": 0, "ms_sum": 0.0, "cost": 0.0})
            j["calls"] += 1
            j["cost"] += float(m.get("cost") or 0)
            if m.get("live"):
                j["live_calls"] += 1
                j["ms_sum"] += float(m.get("ms") or 0)
        return {k: {"calls": v["calls"], "cost": round(v["cost"], 6),
                    "ms_avg": round(v["ms_sum"] / v["live_calls"]) if v["live_calls"] else None}
                for k, v in out.items()}

    def stats(self) -> dict:
        n = self.score.jev_calls
        jobs = self.gemini_jobs()
        dec = jobs.get("decision") or {"calls": 0, "cost": 0.0, "ms_avg": None}
        work = [v for k, v in jobs.items() if k != "decision"]
        return {"parcels": len(self.score.rows), "total": len(self.parcels), "lanes": dict(self.lanes),
                "gemini_skipped": self.skipped, "saved_ms_est": round(self.saved_ms),
                "saved_cost_est": round(self.saved_cost, 6),
                "jev_ms_avg": round(self.score.jev_ms / n) if n else 0, "jev_cost": round(self.jev_cost, 6),
                "gemini_calls": len(self.gem_measured), "gemini_cost": round(self.gemini_cost, 6),
                "gemini_decision_calls": dec["calls"], "gemini_decision_ms_avg": dec["ms_avg"],
                "gemini_decision_cost": dec["cost"],
                "gemini_work_calls": sum(v["calls"] for v in work),
                "gemini_work_cost": round(sum(v["cost"] for v in work), 6), "gemini_jobs": jobs,
                "blocked_tools": self.blocked_tools, "allowed_tools": self.allowed_tools,
                "claims_filed": len(self.claims), "human_pending": len(floor.HUMAN.pending()),
                "policy_version": policy.version(), "thresholds": floor.thresholds(),
                "safety": floor.SAFETY.stats()}

    def emit_stats(self) -> None:
        self.stream("stats", **self.stats())

    async def caption(self, pid: str, k: int, n: int, node: str, text: str) -> None:
        """One caption-bar line for the page (`step` event). The walked parcel pauses here."""
        if not self.walk.active(pid):
            self.stream("step", parcel_id=pid, k=k, n=n, node=node, text=f"Step {k} of {n} · {node} · {text}",
                        sentence=text, walk=False, pause_s=0)
            return
        # walk mode: hold each caption for the full pause, even when a sibling branch (2nd look and
        # read_label run in parallel) is ready to caption; walk.k moves only after the pause ends
        async with self.walk.lock:
            if not self.walk.active(pid):          # the walk ended while this caption queued
                self.stream("step", parcel_id=pid, k=k, n=n, node=node, text=f"Step {k} of {n} · {node} · {text}",
                            sentence=text, walk=False, pause_s=0)
                return
            self.stream("step", parcel_id=pid, k=k, n=n, node=node, text=f"Step {k} of {n} · {node} · {text}",
                        sentence=text, walk=True, pause_s=WALK_PAUSE())
            await asyncio.sleep(WALK_PAUSE())
            self.walk.k = max(self.walk.k, k)
            if k >= n:
                self.walk.done.set()


BELTS: dict[str, Belt] = {}
LAST: dict[str, Belt | None] = {"belt": None}   # the latest workflow run, kept after it ends


def _belt(ctx: Context) -> Belt:
    """The run's Belt. Under `adk web` there is no page, so make one that prints nothing."""
    if ctx.session.id not in BELTS:
        BELTS[ctx.session.id] = Belt(lambda event: None, "workflow")
    return BELTS[ctx.session.id]


def _node(fn: Callable, name: str | None = None, rerun: bool = False) -> FunctionNode:
    """Wrap a node function so the contract stream sees adk_node start/end for it."""
    nm = name or fn.__name__

    async def run(ctx: Context, node_input: Any = None):
        belt = BELTS.get(ctx.session.id)
        if belt:
            belt.stream("adk_node", node=nm, phase="start")
        try:
            out = fn(ctx, node_input)
            if inspect.isawaitable(out):
                out = await out
            return out
        finally:
            if belt:
                belt.stream("adk_node", node=nm, phase="end")

    run.__name__ = nm
    return FunctionNode(func=run, name=nm, rerun_on_resume=rerun)


def _agent_node_events(agent: str):
    def before(callback_context):
        belt = BELTS.get(callback_context.session.id)
        if belt:
            belt.stream("adk_node", node=agent, phase="start")
        return None

    def after(callback_context):
        belt = BELTS.get(callback_context.session.id)
        if belt:
            belt.stream("adk_node", node=agent, phase="end")
        return None
    return before, after


def photo_url(pid: str) -> str:
    return f"/api/photos/{pid}.jpg"


# ── what ADK sends to Gemini, as the Inspector shows it ─────────────────────

def _request_summary(llm_request) -> dict:
    """What ADK is about to send to Gemini: model, instruction, the user parts (image as size only)."""
    cfg = getattr(llm_request, "config", None)
    si = getattr(cfg, "system_instruction", None) if cfg else None
    if si is not None and not isinstance(si, str):
        si = " ".join(p.text or "" for p in (getattr(si, "parts", None) or []) if getattr(p, "text", None))
    parts = []
    for content in (getattr(llm_request, "contents", None) or [])[-3:]:
        for part in content.parts or []:
            if getattr(part, "text", None):
                parts.append({"role": content.role, "text": part.text[:2500]})
            elif getattr(part, "inline_data", None) is not None:
                blob = part.inline_data
                parts.append({"role": content.role, "inline_data": blob.mime_type, "bytes": len(blob.data or b"")})
            elif getattr(part, "function_call", None) is not None:
                parts.append({"role": content.role, "function_call": part.function_call.name,
                              "args": dict(part.function_call.args or {})})
            elif getattr(part, "function_response", None) is not None:
                parts.append({"role": content.role, "function_response": part.function_response.name,
                              "response": part.function_response.response})
    schema = getattr(cfg, "response_schema", None) if cfg else None
    tools = sorted((getattr(llm_request, "tools_dict", None) or {}).keys())
    return {"model": getattr(llm_request, "model", None) or GEMINI_MODEL,
            "system_instruction": (si or "")[:2500], "contents": parts, "tools": tools,
            "response_schema": getattr(schema, "__name__", None) or (str(schema)[:80] if schema else None),
            "thinking": "include_thoughts=True"}


_PARCEL_RE = re.compile(r"PARCEL ((?:P|DEMO)-[A-Za-z0-9-]+)")


def _texts(llm_request) -> list[str]:
    return [p.text for c in (getattr(llm_request, "contents", None) or []) for p in (c.parts or [])
            if getattr(p, "text", None)]


def _parcel_of(llm_request) -> str | None:
    for text in _texts(llm_request):
        m = _PARCEL_RE.search(text)
        if m:
            return m.group(1)
    return None


def _has_function_response(llm_request) -> bool:
    contents = getattr(llm_request, "contents", None) or []
    return bool(contents) and any(getattr(p, "function_response", None) is not None
                                  for p in (contents[-1].parts or []))


def _json_response(obj: Any, **meta: Any) -> LlmResponse:
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(text=json.dumps(obj))]),
                       custom_metadata=meta or None)


# ── replay: if Gemini fails (or BELT_REPLAY=1), answer from the rehearsal recording ──

def _jev_view(v: dict | None) -> dict:
    a = (v or {}).get("answers") or {}
    return {"choice": (a.get("action") or {}).get("choice"),
            "confidence": float((a.get("action") or {}).get("confidence") or 0),
            "probabilities": (a.get("action") or {}).get("probabilities") or {},
            "damaged": float((a.get("damaged") or {}).get("noul") or 0)}


def _replay_response(agent: str, callback_context, llm_request, reason: str) -> LlmResponse | None:
    belt = BELTS.get(callback_context.session.id)
    pid = _parcel_of(llm_request)
    if agent == "claims_clerk":
        idx = str(callback_context.state.get("label_index"))
        packet = jev.replay_get("gemini", idx)
        lab = belt.label if belt else None
        if packet is None and lab:          # no recording: build it from the key, flagged
            packet = {"tracking": "UNREADABLE" if lab["smudged"] else lab["tracking"],
                      "consignee_zip": "UNREADABLE" if lab["smudged"] else lab["zip"],
                      "service": lab["service"], "marks": lab["marks"],
                      "declared_contents": lab["declared_contents"],
                      "claim_note": "Replay: built from the answer key, not read by Gemini."}
        if packet is None:
            return None
        if not _has_function_response(llm_request):
            # step 1 of the clerk's turn: propose the tool call (recorded, or built from the packet)
            fc = jev.replay_get("clerk_tool", idx) or {
                "name": "file_claim",
                "args": {"tracking": packet.get("tracking"), "consignee_zip": packet.get("consignee_zip"),
                         "claim_note": packet.get("claim_note", "")}}
            args = {**(fc.get("args") or {}), "parcel_id": pid or (fc.get("args") or {}).get("parcel_id")}
            if belt:
                belt.emit("gemini_replay", node=agent, reason=reason[:160])
            return LlmResponse(content=types.Content(role="model", parts=[types.Part(
                function_call=types.FunctionCall(name=fc.get("name", "file_claim"), args=args))]))
    elif agent == "second_look":
        packet = jev.replay_get("second_look", pid or "")
        if packet is None and belt and pid in belt.verdicts:
            j = _jev_view(belt.verdicts[pid])
            choice = j["choice"] if j["choice"] in floor.SECOND_LOOK_ACTIONS else "hold"
            top = max(j["probabilities"].values()) if j["probabilities"] else 0
            packet = {"action": choice, "needs_human": top < 0.55,
                      "reason": "Replay: built by code from Jev's answer, not Gemini."}
    elif agent == "gemini_reflex":
        packet = jev.replay_get("gemini_reflex", pid or "")     # recorded live answers only, never built
    elif agent == "teacher":
        packet = _replay_teacher()
    else:
        # Never replay a recorded report: its numbers belong to another run. Build it from this
        # run's scorecard and say plainly that Gemini did not write it.
        s = belt.score.snapshot() if belt else {}
        st = belt.stats() if belt else {}
        packet = {"headline": "Shift complete (replay, not Gemini)",
                  "report": (f"Replay mode: Gemini did not write this report. {s.get('parcels', 0)} parcels, "
                             f"{s.get('correct', 0)} correct and {s.get('safe', 0)} safe, "
                             f"{s.get('near_miss', 0)} near-miss ships, {st.get('claims_filed', 0)} claims filed, "
                             f"lanes {st.get('lanes')}, Gemini skipped {st.get('gemini_skipped', 0)} times. "
                             f"Jev averaged {s.get('jev_ms_avg', 0)} ms per decision.")}
    if packet is None:
        return None
    if belt:
        belt.emit("gemini_replay", node=agent, reason=reason[:160])
    return _json_response(packet)


def _replay_teacher() -> dict:
    """A recorded proposal only if it is about this run's decided parcels; else built by code, flagged."""
    decided = floor.HUMAN.decided()
    ids = {d["parcel_id"] for d in decided}
    rec = jev.replay_get("teacher", "last")
    if rec and set(rec.get("parcel_ids") or []) and set(rec["parcel_ids"]) <= ids:
        return rec
    current = policy.current_options()
    by_action: dict[str, list[dict]] = {}
    for d in decided:
        by_action.setdefault(d["action"], []).append(d)
    changes = []
    groups = sorted(by_action.items(), key=lambda kv: -len(kv[1]))[:2]
    for action, items in groups:
        seen = ", ".join(sorted({i.get("declared", "?") for i in items}))[:120]
        changes.append({"option": action,
                        "new_text": (current[action].rstrip() + f" Also when a person decided so for: {seen}.")[:400]})
    rule = ""
    if groups:
        action, items = groups[0]
        kinds = sorted({str(i.get("declared") or "?").split(",")[0].lower() for i in items})[:2]
        verb = {"ship": "ships", "retape": "is retaped", "hold": "is held for a person",
                "return": "goes back to the sender"}.get(action, action)
        rule = f"A box like these ({' or '.join(kinds)}) {verb}, as the person decided."
    return {"changes": changes, "parcel_ids": sorted(ids), "rule_text": rule,
            "rationale": "Replay: built by code from the human decisions, not written by Gemini."}


# ── every Gemini call: record, stream, skip, replay (ADK model callbacks) ────

OPEN: dict[str, dict] = {}        # open Gemini call per (session, node path, agent)


def _key(callback_context, agent: str) -> str:
    return f"{callback_context.session.id}|{getattr(callback_context, 'node_path', '') or ''}|{agent}"


def _close(key: str, raw: str, function_calls: list[dict], usage, live: bool, error: str | None = None) -> None:
    o = OPEN.pop(key, None)
    if o is None:
        return
    rec, belt, agent = o["rec"], o["belt"], o["agent"]
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = None
    ms = round((time.time() - rec["t_start"]) * 1000)
    tin = getattr(usage, "prompt_token_count", None) if usage is not None else None
    tout = getattr(usage, "candidates_token_count", None) if usage is not None else None
    tthought = getattr(usage, "thoughts_token_count", None) if usage is not None else None
    total = getattr(usage, "total_token_count", None) if usage is not None else None
    cost = floor.gemini_cost(tin, tout, tthought) if live else 0.0
    fields = {"ms": ms, "raw_text": raw, "thoughts": o["thoughts"][-4000:], "parsed": parsed,
              "function_calls": function_calls or None, "input_tokens": tin, "output_tokens": tout,
              "thought_tokens": tthought, "total_tokens": total, "cost_usd": cost, "live": live}
    if error:
        fields["error"] = error
    calls.finish(rec, **fields)
    output: Any = parsed if parsed is not None else (
        {"function_call": function_calls[0]} if function_calls else raw)
    if belt is not None:
        belt.last_llm_call[agent] = rec["id"]
        belt.gem_measured.append({"agent": agent, "ms": ms, "cost": cost, "live": live})
        belt.gemini_cost += cost
        if total:
            belt.score.gemini_tokens += int(total)
        belt.stream("llm_end", call_id=rec["id"], agent=agent, job=job_of(agent), parcel_id=o["parcel_id"],
                    ms=ms, tokens_in=tin,
                    tokens_out=tout, thought_tokens=tthought, cost=cost, live=live, output=output,
                    error=error)
        belt.emit_stats()


def _second_look_gate(belt: Belt | None, llm_request) -> LlmResponse | None:
    """The "Gemini skipped" short-circuit. Jev confident (or abstaining to a person) -> no Gemini call."""
    pid = _parcel_of(llm_request)
    if belt is None or pid not in belt.verdicts:
        return None
    j = _jev_view(belt.verdicts[pid])
    if pid in belt.auditing:
        return None                         # audit sample: a real shadow 2nd look on an auto parcel
    g = belt.verdicts[pid].get("gate") or {}
    lane, why = g.get("lane"), g.get("reason", "")
    if lane is None:                        # no gate result yet (e.g. adk web): the old cascade
        lane, why = floor.lane_for(j["confidence"], floor.thresholds())
    if lane == "gemini":
        return None
    est = floor.skip_estimate(belt.gem_measured)
    belt.skipped += 1
    belt.saved_ms += est["saved_ms_est"]
    belt.saved_cost += est["saved_cost_est"]
    belt.stream("gemini_skipped", parcel_id=pid, saved_ms_est=est["saved_ms_est"],
                saved_cost_est=est["saved_cost_est"], basis=est["basis"], lane=lane,
                confidence=round(j["confidence"], 3), reason=why, by="before_model_callback")
    action = j["choice"] if j["choice"] in floor.SECOND_LOOK_ACTIONS else "hold"
    return _json_response({"action": action, "needs_human": lane == "human",
                           "reason": f"Gemini skipped by before_model_callback: {why}"}, belt_skipped=True)


def _llm_callbacks(agent: str):
    async def before(callback_context, llm_request):
        belt = BELTS.get(callback_context.session.id)
        if agent == "second_look":
            skip = _second_look_gate(belt, llm_request)
            if skip is not None:
                return skip
        forced = forced_replay()
        pid = _parcel_of(llm_request)
        legacy_parcel = (f"label #{callback_context.state.get('label_index')}" if agent == "claims_clerk"
                         else "shift log" if agent == "shift_lead" else None)
        rec = calls.start("gemini", agent=agent, job=job_of(agent), job_label=JOB_LABELS.get(agent, agent),
                          model=GEMINI_MODEL, purpose=agent, live=not forced,
                          request=_request_summary(llm_request), parcel=pid or legacy_parcel)
        key = _key(callback_context, agent)
        OPEN[key] = {"rec": rec, "belt": belt, "agent": agent, "parcel_id": pid, "thoughts": "", "text": ""}
        if belt:
            belt.gem_calls[agent] = rec
            belt.stream("llm_start", call_id=rec["id"], agent=agent, job=job_of(agent),
                        job_label=JOB_LABELS.get(agent, agent), parcel_id=pid, live=not forced)
        if forced:
            # keep the slow branch slow on stage, so the two speeds still show
            await asyncio.sleep(REPLAY_GEMINI_SECONDS())
            resp = _replay_response(agent, callback_context, llm_request, "replay forced")
            _close_from_response(key, resp, live=False, error="replay forced (BELT_REPLAY=1)")
            return resp
        return None

    def after(callback_context, llm_response):
        key = _key(callback_context, agent)
        o = OPEN.get(key)
        if o is None:
            return None
        parts = (llm_response.content.parts if llm_response.content else None) or []
        if llm_response.partial:
            text = "".join(p.text or "" for p in parts if p.text and not getattr(p, "thought", False))
            thought = "".join(p.text or "" for p in parts if p.text and getattr(p, "thought", False))
            o["text"] += text
            o["thoughts"] += thought
            if o["belt"] is not None and (text or thought):
                o["belt"].stream("llm_delta", call_id=o["rec"]["id"], agent=agent, text=text or thought,
                                 thought=bool(thought and not text))
            return None
        _close_from_response(key, llm_response, live=True)
        return None

    def on_error(callback_context, llm_request, error):
        key = _key(callback_context, agent)
        resp = _replay_response(agent, callback_context, llm_request, f"{type(error).__name__}: {error}")
        _close_from_response(key, resp, live=False, error=f"{type(error).__name__}: {str(error)[:200]}")
        return resp
    return before, after, on_error


def _close_from_response(key: str, resp: LlmResponse | None, live: bool, error: str | None = None) -> None:
    parts = (resp.content.parts if resp is not None and resp.content else None) or []
    raw = "".join(p.text or "" for p in parts if p.text and not getattr(p, "thought", False))
    fcs = [{"name": p.function_call.name, "args": dict(p.function_call.args or {})}
           for p in parts if getattr(p, "function_call", None) is not None]
    o = OPEN.get(key)
    if o is not None and not raw and o["text"] and not fcs:
        raw = o["text"]
    _close(key, raw, fcs, resp.usage_metadata if resp is not None else None, live, error)


# ── the second look: Gemini on escalation only ──────────────────────────────

class SecondLook(BaseModel):
    action: Literal["ship", "retape", "hold", "return"] = Field(description="What the sorter should do.")
    reason: str = Field(description="One sentence under 25 words: what in the photo decided it.")
    needs_human: bool = Field(description="True if a person must open or check the parcel.")


_sl_before, _sl_after, _sl_error = _llm_callbacks("second_look")
_sl_node_before, _sl_node_after = _agent_node_events("second_look")

second_look = LlmAgent(
    name="second_look",
    model=GEMINI_MODEL,
    description="Takes a second look at a parcel Jev was unsure about.",
    instruction=(
        "You take a second look at one parcel on a sorting belt. A fast vision model (Jev) already "
        "looked and was unsure. You get the same photo, the declared contents, the sorting policy (the "
        "option texts) and Jev's probabilities. Decide what the sorter should do: ship, retape, hold or "
        "return, following the policy text. Set needs_human to true when you cannot tell from the photo, "
        "or when fragile contents may be broken and a person must open it. Give one short reason."
    ),
    output_schema=SecondLook,
    generate_content_config=types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(include_thoughts=True)),
    before_model_callback=_sl_before,
    after_model_callback=_sl_after,
    on_model_error_callback=_sl_error,
    before_agent_callback=_sl_node_before,
    after_agent_callback=_sl_node_after,
)


def second_look_content(belt: Belt, pid: str) -> types.Content:
    p = belt.by_id[pid]
    j = _jev_view(belt.verdicts.get(pid))
    pol = policy.current_options()
    text = (f"PARCEL {pid}\nDeclared contents: {p['declared']}\n"
            f"Sorting policy (option -> text):\n" +
            "\n".join(f"- {k}: {pol[k]}" for k in floor.SECOND_LOOK_ACTIONS) +
            f"\nJev's answer: choice={j['choice']} confidence={j['confidence']:.2f} "
            f"probabilities={json.dumps({k: round(float(v), 3) for k, v in j['probabilities'].items()})} "
            f"damaged={j['damaged']:.2f}\n"
            + (f"Floor note: {note}\n" if (note := _floor_note(belt, pid)) else "")
            + "Look at the photo and decide.")
    data = (engine.ROOT / p["file"]).read_bytes()
    return types.Content(role="user", parts=[types.Part(text=text),
                                             types.Part.from_bytes(data=data, mime_type="image/jpeg")])


def _floor_note(belt: Belt, pid: str) -> str:
    if pid in belt.auditing:
        v = belt.verdicts.get(pid) or {}
        return (f"audit sample: Jev already decided '{(v.get('decision') or {}).get('action')}' alone "
                "(confident). Check it independently.")
    g = (belt.verdicts.get(pid) or {}).get("gate") or {}
    return f"sent to you by rule {g['rule']}: {g['reason']}" if g.get("rule") else ""


def _send_to_person(belt: Belt, pid: str, reason: str, gemini: dict | None = None, kind: str = "decide") -> None:
    """kind "decide": the parcel waits for the person. kind "audit": shadow review of a parcel Jev already
    decided alone (the belt did not wait); the person's answer becomes the audit label."""
    p = belt.by_id[pid]
    j = _jev_view(belt.verdicts.get(pid))
    v = belt.verdicts.get(pid) or {}
    g = v.get("gate") or {}
    d = v.get("decision") or {}
    info = {"rule": g.get("rule"), "tier": g.get("tier"), "checks": g.get("checks"),
            "legacy_lane": g.get("legacy_lane"), "damaged": d.get("damaged"), "risk": d.get("risk"),
            "probabilities": d.get("probabilities"), "handling": engine.handling_marks(p),
            "auto_action": d.get("action") if kind == "audit" else None,
            # the answer key, for the presenter's ANSWER KEY chip in the review pop-up (?presenter=1 or K)
            "truth": (p.get("truth") or {}).get("action")}
    floor.HUMAN.add(pid, reason, declared=p["declared"], photo_url=photo_url(pid), file=p["file"],
                    jev=j, second_look=gemini, policy_version=policy.version(), kind=kind, **info)
    belt.stream("human_queue", parcel_id=pid, reason=reason, photo_url=photo_url(pid), declared=p["declared"],
                jev_action=j["choice"], confidence=round(j["confidence"], 3), second_look=gemini, kind=kind,
                **info)


def _finish_audit(belt: Belt, pid: str, verdict: dict) -> None:
    """The shadow 2nd look on an audited auto parcel is back. The decision stands either way."""
    if "Gemini skipped" not in str(verdict.get("reason", "")):
        rec_ = calls.get(belt.last_llm_call.get("second_look") or "")
        if rec_ and rec_.get("live"):
            jev.replay_put("second_look", f"audit|{pid}", verdict)
    truth = (belt.by_id.get(pid) or {}).get("truth", {}).get("action")
    rec, change = floor.SAFETY.finish_audit(pid, verdict, truth)
    belt.stream("audit", phase="done", **{k: rec.get(k) for k in (
        "parcel_id", "auto_action", "gemini_action", "gemini_reason", "needs_human", "flagged", "error", "label",
        "label_source")})
    if rec.get("flagged"):
        why = (f"audit: Jev auto-{rec.get('auto_action')}, Gemini says {rec.get('gemini_action')}"
               + (" and asks for a person" if rec.get("needs_human") else "") + " (shadow review, belt did not wait)")
        _send_to_person(belt, pid, why, gemini=verdict, kind="audit")
    if change:
        belt.stream("drift", **change, effective=floor.effective_bars(floor.thresholds(), floor.SAFETY.drift()))


def _make_desk(i: int):
    async def desk(ctx: Context, node_input) -> None:
        """One second-look desk. ADK runs graph nodes one trigger at a time, so N desks = N at once."""
        belt = _belt(ctx)
        pid = (node_input or {}).get("parcel_id")
        audit = bool((node_input or {}).get("audit"))
        try:
            out = await ctx.run_node(second_look, node_input=second_look_content(belt, pid), run_id=f"sl-{pid}")
            verdict = out.model_dump() if hasattr(out, "model_dump") else dict(out or {})
            if audit:
                _finish_audit(belt, pid, verdict)
                return None
            if "Gemini skipped" not in str(verdict.get("reason", "")):
                rec_id = belt.last_llm_call.get("second_look")
                rec = calls.get(rec_id or "")
                if rec and rec.get("live"):
                    jev.replay_put("second_look", pid, verdict)
            j = _jev_view(belt.verdicts.get(pid))
            lane, why = floor.after_second_look(verdict, j["damaged"])
            n = (belt.verdicts.get(pid) or {}).get("steps") or 3
            await belt.caption(pid, 3, n, "2nd look", f"Gemini looks again: {str(verdict.get('action')).upper()}"
                               + (" → Gemini decides" if lane == "gemini" else " but is unsure too → human desk"))
            if lane == "gemini":
                belt.score.update(pid, verdict["action"])
                belt.stream("decision", parcel_id=pid, final_action=verdict["action"], decided_by="gemini",
                            reason=verdict.get("reason"))
            else:
                belt.lanes["gemini"] -= 1
                belt.lanes["human"] += 1
                belt.lane_of[pid] = "human"
                belt.stream("route", parcel_id=pid, lane="human", reason=why,
                            confidence=round(j["confidence"], 3), thresholds=floor.thresholds(),
                            escalated_from="gemini")
                _send_to_person(belt, pid, why, gemini=verdict)
                belt.stream("decision", parcel_id=pid, final_action="hold", decided_by="code",
                            reason="held for a person")
        finally:
            if audit:
                belt.auditing.discard(pid)
            belt.desk_load[i] = max(0, belt.desk_load[i] - 1)
            belt.pending_slow -= 1
            belt.emit_stats()
        return None
    desk.__name__ = f"second_look_desk_{i}"
    return desk


# ── the slow branch: Gemini reads the label of a damaged parcel, proposes a tool ──

class ClaimPacket(BaseModel):
    tracking: str = Field(description="Tracking number exactly as printed, e.g. 'DX 1234 5678 9012'. "
                                      "Write UNREADABLE if you cannot read every digit.")
    consignee_zip: str = Field(description="5-digit ZIP of the SHIP TO address. UNREADABLE if not sure.")
    service: str = Field(description="GROUND, 2DAY or OVERNIGHT")
    marks: list[str] = Field(description="Handling marks on the label. Each one of: FRAGILE, THIS_SIDE_UP, "
                                         "LITHIUM_BATTERY, KEEP_DRY. Use [\"NONE\"] if there are none.")
    declared_contents: str
    claim_note: str = Field(description="One sentence under 25 words for the damage claim.")


async def read_label(ctx: Context, node_input) -> Event:
    """Pull the label of the damaged parcel and hand the picture to Gemini.

    One label at a time: read_label -> claims_clerk -> claim_ready is a chain of three nodes, so the
    next read waits here until claim_ready has graded the one in flight (the belt never waits)."""
    belt = _belt(ctx)
    pid = (node_input or {}).get("parcel_id")
    if belt.walk.active(pid):                  # walk mode: the label read comes after the lane step
        deadline = time.perf_counter() + WALK_MAX_WAIT
        while belt.walk.k < 3 and time.perf_counter() < deadline:
            await asyncio.sleep(0.05)
    while belt.reading:
        await asyncio.sleep(0.05)
    v = belt.verdicts.get(pid) or {}
    if belt.reads_for.get(pid, 0) == 0:
        await belt.caption(pid, 4, v.get("steps") or 5, "read_label",
                           f"Jev sees damage {_num(_jev_view(v)['damaged'])} → Gemini reads the label")
    parcel = belt.by_id.get(pid) or {"declared": None}
    lab = belt.next_label(parcel["declared"])
    belt.reads_for[pid] = belt.reads_for.get(pid, 0) + 1
    belt.reading = True
    png = label.render_png(lab)
    belt.emit("gemini_start", node="claims_clerk", label_index=lab["index"], smudged=lab["smudged"],
              url=f"/api/label/{lab['index']}.png", parcel=pid)
    belt.stream("label_read", parcel_id=pid, label_index=lab["index"], url=f"/api/label/{lab['index']}.png",
                scan=belt.reads_for[pid], declared=parcel["declared"])
    content = types.Content(role="user", parts=[
        types.Part(text=f"PARCEL {pid}. Manifest declared contents: {parcel['declared']}. "
                        f"This shipping label is on this damaged parcel (scan {belt.reads_for[pid]}). "
                        "Read it into the claim packet, then propose exactly one action with a tool."),
        types.Part.from_bytes(data=png, mime_type="image/png"),
    ])
    return Event(output=content, state={"reading_since": belt.now(), "label_index": lab["index"],
                                        "claim_parcel": pid})


def _execute_claim(tool_context: ToolContext, tool: str, args: dict) -> dict:
    """Runs only when the guard allowed it. Shared state gets the filed claim."""
    belt = BELTS.get(tool_context.session.id)
    pid = args.get("parcel_id")
    claim_id = f"C-{len(belt.claims) + 1:03d}" if belt else "C-000"
    if belt:
        belt.claims[pid] = {"claim_id": claim_id, "tool": tool, **args}
        belt.score.update(pid, tool)
        belt.stream("decision", parcel_id=pid, final_action=tool, decided_by="code",
                    proposed_by="claims_clerk", claim_id=claim_id)
        belt.emit_stats()
    tool_context.state["claim"] = {"claim_id": claim_id, "tool": tool, **args}
    return {"status": "filed" if tool == "file_claim" else "refund issued", "claim_id": claim_id}


def file_claim(parcel_id: str, tracking: str, consignee_zip: str, claim_note: str,
               tool_context: ToolContext) -> dict:
    """File a carrier damage claim for this damaged parcel, using the fields from the claim packet."""
    return _execute_claim(tool_context, "file_claim", {"parcel_id": parcel_id, "tracking": tracking,
                                                       "consignee_zip": consignee_zip, "claim_note": claim_note})


def issue_refund(parcel_id: str, tracking: str, amount_usd: float, reason: str, tool_context: ToolContext) -> dict:
    """Refund the customer for this parcel (when the contents are likely broken). amount_usd = estimated value."""
    return _execute_claim(tool_context, "issue_refund", {"parcel_id": parcel_id, "tracking": tracking,
                                                         "amount_usd": amount_usd, "reason": reason})


async def guard_tool_call(tool, args: dict, tool_context: ToolContext) -> dict | None:
    """ADK before_tool_callback: a deterministic gate in front of the tool Gemini chose.
    Returning a dict means the tool does not run; Gemini gets the dict as the tool's answer."""
    if tool.name not in floor.GUARDED_TOOLS:
        return None                                    # e.g. set_model_response: not an action
    belt = BELTS.get(tool_context.session.id)
    args = dict(args or {})
    pid = args.get("parcel_id")
    call_id = belt.last_llm_call.get("claims_clerk") if belt else None
    verdict = _jev_view(belt.verdicts[pid]) if belt and pid in belt.verdicts else None
    res = floor.guard_tool(tool.name, args, verdict, already_filed=bool(belt and pid in belt.claims))
    if belt:
        belt.stream("tool_proposed", call_id=call_id, agent="claims_clerk", tool=tool.name, args=args,
                    parcel_id=pid)
        belt.stream("guard_verdict", call_id=call_id, allowed=res["allowed"], rule=res["rule"],
                    evidence=res["evidence"], tool=tool.name, parcel_id=pid, by="before_tool_callback")
        if res["allowed"]:
            belt.allowed_tools += 1
        else:
            belt.blocked_tools += 1
        belt.emit_stats()
        if call_id:
            calls.annotate(call_id, decision=f"{tool.name} {'ALLOWED' if res['allowed'] else 'BLOCKED'}",
                           why=res["rule"])
        idx = str(tool_context.state.get("label_index"))
        rec = calls.get(call_id or "")
        if rec and rec.get("live"):
            jev.replay_put("clerk_tool", idx, {"name": tool.name, "args": args})
        if pid in belt.verdicts:
            n = belt.verdicts[pid].get("steps") or 5
            await belt.caption(pid, n, n, "tool gate", caption_tool(tool.name, res["allowed"], res["rule"],
                                                                     (verdict or {}).get("damaged")))
    if res["allowed"]:
        return None
    return {"status": "blocked", "rule": res["rule"],
            "message": "The floor manager blocked this action. Do not retry it; return the packet as read."}


# The read-only part of the clerk's job (scripts/live_gemini.py uses it on its own, without tools).
CLERK_READ_INSTRUCTION = (
    "You are a claims clerk at a parcel sorting hub. You get one image of a shipping label from "
    "the fictional carrier DEVFEST EXPRESS. Copy the fields exactly as printed. If any digit of the "
    "tracking number or ZIP is smudged or hidden, write UNREADABLE for that field. Never guess."
)

_clerk_before, _clerk_after, _clerk_error = _llm_callbacks("claims_clerk")
_clerk_node_before, _clerk_node_after = _agent_node_events("claims_clerk")

claims_clerk = LlmAgent(
    name="claims_clerk",
    model=GEMINI_MODEL,
    description="Reads a shipping label image, fills in a damage claim packet, proposes the claim action.",
    instruction=(
        "You are a claims clerk at a parcel sorting hub. You get one image of a shipping label from "
        "the fictional carrier DEVFEST EXPRESS, on a parcel that looked damaged. Copy the fields exactly as "
        "printed. If any digit of the tracking number or ZIP is smudged or hidden, write UNREADABLE for that "
        "field. Never guess. Then propose exactly one action by calling a tool, with the parcel id and the "
        "fields you read (copy UNREADABLE as is): file_claim for a carrier damage claim, or issue_refund "
        "when the contents are fragile and probably broken (estimate amount_usd). A floor manager checks "
        "your proposal and may block it; do not call a second tool. Then return the packet."
    ),
    output_schema=ClaimPacket,
    output_key="claim_packet",
    tools=[file_claim, issue_refund],
    before_tool_callback=guard_tool_call,
    # Stream Gemini's thought summaries too, so the audience can watch it think.
    generate_content_config=types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(include_thoughts=True)),
    before_model_callback=_clerk_before,
    after_model_callback=_clerk_after,
    on_model_error_callback=_clerk_error,
    before_agent_callback=_clerk_node_before,
    after_agent_callback=_clerk_node_after,
)


def claim_ready(ctx: Context, node_input) -> Event:
    """Code grades Gemini's packet against the hidden label key. Result goes into state."""
    belt = _belt(ctx)
    packet = (node_input.model_dump() if hasattr(node_input, "model_dump")
              else dict(node_input) if isinstance(node_input, dict) else {})
    graded = label.judge(belt.label, packet)
    belt.score.gemini_calls += 1
    belt.reading = False
    ok = graded["correct"]
    pid = ctx.state.get("claim_parcel")
    filed = pid in belt.claims
    # Re-scan when nothing was filed (blocked or misread), at most once per parcel, and never past
    # MAX_TICKS label reads in a run.
    retry = (not filed) and belt.reads_for.get(pid, 0) < MAX_READS_PER_PARCEL and belt.labels_read < engine.MAX_TICKS
    took = round(belt.now() - float(ctx.state.get("reading_since") or 0), 2)
    belt.emit("claim", ok=ok, packet=packet, graded=graded, took=took, retry=retry, node="claim_ready",
              parcel=pid, filed=filed)
    jv = _jev_view(belt.verdicts.get(pid))
    belt.stream("claim_packet", parcel_id=pid, packet=packet, graded=graded, filed=filed, took=took,
                retry=retry, claim=belt.claims.get(pid), scan=belt.reads_for.get(pid, 0),
                url=f"/api/label/{graded['label_index']}.png", declared=(belt.by_id.get(pid) or {}).get("declared"),
                jev={"choice": jv["choice"], "confidence": jv["confidence"], "damaged": jv["damaged"]})
    rec = calls.get(belt.last_llm_call.get("claims_clerk") or "")
    if rec and rec.get("live"):
        jev.replay_put("gemini", str(belt.label["index"]), packet)
    if not retry:
        belt.pending_slow -= 1
        belt.emit_stats()
        if belt.walk.active(pid):              # no tool step came (e.g. no proposal): end the walk here
            belt.walk.done.set()
    return Event(output={"parcel_id": pid},
                 state={"handling": "none noted",
                        "claim_graded": {"parcel_id": pid, "correct": ok, "filed": filed}},
                 route="retry" if retry else "stored")


def rest(ctx: Context, node_input) -> None:
    """The claim is done. Returning None ends this branch without a second graph output."""
    return None


# ── the fast branch: Jev judges every photo, the gate picks the lane ────────

def enter(ctx: Context, node_input) -> Event:
    belt = _belt(ctx)
    floor.HUMAN.reset()
    floor.SAFETY.reset()
    belt.emit("run_start", mode=belt.mode, parcels=len(belt.parcels), gemini_model=GEMINI_MODEL,
              jev_model=jev.MODEL, replay=jev.force_replay(), pace=belt.pace, policy=policy.STATE["name"])
    belt.stream("run_start", mode=belt.mode, total=len(belt.parcels), gemini_model=GEMINI_MODEL,
                jev_model=jev.MODEL, replay_jev=jev.force_replay(), replay_gemini=forced_replay(),
                pace=belt.pace, thresholds=floor.thresholds(), policy_version=policy.version(),
                policy_name=policy.STATE["name"], desks=N_DESKS,
                safety={"effective": floor.effective_bars(floor.thresholds(), floor.SAFETY.drift()),
                        "source": floor.THRESHOLD_SOURCE, "audit_rate": floor.SAFETY_CONFIG["audit_rate"],
                        "alpha": floor.SAFETY_CONFIG["alpha"], "legacy": floor.LEGACY, "seed": belt.seed})
    belt.emit_stats()
    return Event(output="belt", state={"tick": 0, "claim": None, "handling": "none noted"})


async def tick(ctx: Context, node_input) -> Event:
    """One parcel, one Jev call. Async, so Gemini's branches keep running while this one waits."""
    belt = _belt(ctx)
    if belt.walk.enabled and belt.walk.pid is not None and not belt.walk.done.is_set():
        try:                                   # walk mode: the belt waits for parcel 1 to finish its walk
            await asyncio.wait_for(belt.walk.done.wait(), WALK_MAX_WAIT)
        except asyncio.TimeoutError:
            belt.walk.done.set()
    await asyncio.sleep(belt.pace)
    parcel = belt.parcels[belt.index]
    belt.index += 1
    pid = parcel["id"]
    if belt.walk.enabled and belt.walk.pid is None:
        belt.walk.pid = pid
    url = f"/api/photo/{pid}.jpg"
    belt.emit("parcel", id=pid, url=url, declared=parcel["declared"], credit=parcel.get("credit"),
              n=belt.index, total=len(belt.parcels))
    belt.stream("parcel", parcel_id=pid, photo_url=photo_url(pid), declared=parcel["declared"],
                index=belt.index, total=len(belt.parcels), credit=parcel.get("credit"))
    belt.emit("jev_start", node="tick", id=pid, policy_version=policy.version())
    started = belt.now()
    answers = await jev.judge_photo(belt.jev, pid, engine.ROOT / parcel["file"], parcel["declared"],
                                    None, claim_ready=False, photo_url=url)
    th = floor.thresholds()
    decision = reflex.choose(answers, claim_ready=False, handling=None, trust=th["abstain"], auto_ship=th["auto"])
    cost = (answers.get("input_tokens") or 0) * calls.PRICE_PER_MILLION_INPUT / 1_000_000 if not answers.get("replay") else 0.0
    belt.jev_cost += cost
    belt.verdicts[pid] = {"answers": answers, "decision": decision, "started": started}
    belt.stream("jev_call", call_id=answers.get("call_id"), parcel_id=pid, ms=answers["ms"],
                tokens_in=answers.get("input_tokens"), tokens_out=answers.get("output_tokens"),
                cost=round(cost, 7), live=not answers.get("replay"),
                probabilities=decision["probabilities"], confidence=decision["confidence"],
                action=decision["action"], model_choice=decision["model_choice"], why=decision["why"],
                damaged=decision["damaged"], risk=decision["risk"], box=decision["box"],
                model=answers.get("model"), policy_version=policy.version())
    preview = floor.gate_route(decision["model_choice"], decision["confidence"], decision["damaged"],
                               decision["risk"], parcel["declared"], engine.handling_marks(parcel), th,
                               floor.SAFETY.drift())
    claim = decision["damaged"] >= reflex.CLAIM_ON_DAMAGE and decision["model_choice"] in ("hold", "return")
    n = plan_steps(preview["lane"], claim)
    belt.verdicts[pid]["steps"] = n
    await belt.caption(pid, 1, n, "tick", f"Jev answered in {answers['ms'] / 1000:.2f} s: "
                                          f"{str(decision['model_choice']).upper()}, confidence "
                                          f"{_num(decision['confidence'])}")
    return Event(output={"parcel_id": pid}, state={"tick": belt.index})


async def gate(ctx: Context, node_input) -> Event:
    """The floor manager. Picks the lane from Jev's confidence and the runtime thresholds."""
    belt = _belt(ctx)
    pid = (node_input or {})["parcel_id"]
    parcel = belt.by_id[pid]
    v = belt.verdicts[pid]
    answers, decision = v["answers"], v["decision"]
    th = floor.thresholds()
    drift = floor.SAFETY.drift()
    g = floor.gate_route(decision["model_choice"], decision["confidence"], decision["damaged"], decision["risk"],
                         parcel["declared"], engine.handling_marks(parcel), th, drift)
    v["gate"] = g
    floor.SAFETY.note_route(pid, g)
    lane, reason = g["lane"], g["reason"]
    belt.stream("route", parcel_id=pid, lane=lane, reason=reason, confidence=decision["confidence"],
                thresholds=th, rule=g["rule"], tier=g["tier"], bar=g["bar"], checks=g["checks"],
                legacy_lane=g["legacy_lane"], legacy_reason=g["legacy_reason"],
                effective=floor.effective_bars(th, drift), drift=drift["state"])
    n = v.get("steps") or plan_steps(lane, False)
    await belt.caption(pid, 2, n, "gate", caption_gate(g, decision["confidence"], decision["model_choice"]))
    audit = lane == "auto" and floor.SAFETY.wants_audit(pid)
    if lane != "gemini" and not audit:
        # Same LlmAgent, same input as an escalation: its before_model_callback skips Gemini.
        await ctx.run_node(second_look, node_input=second_look_content(belt, pid), run_id=f"sl-{pid}")
    routes: list[str] = []
    final: str | None
    if lane == "auto":
        final = decision["action"]
        by = "jev" if decision["action"] == decision["model_choice"] else "code"
        floor.SAFETY.note_auto(pid, final, (parcel.get("truth") or {}).get("action"))
        if audit:
            # Audit sample: the decision stands (the belt does not wait); Gemini looks again in shadow.
            belt.auditing.add(pid)
            floor.SAFETY.start_audit(pid, final)
            belt.stream("audit", phase="start", parcel_id=pid, auto_action=final,
                        rate=floor.SAFETY_CONFIG["audit_rate"])
            desk = min(range(N_DESKS), key=lambda i: belt.desk_load[i])
            belt.desk_load[desk] += 1
            belt.pending_slow += 1
            routes.append(f"audit{desk}")
    elif lane == "human":
        final, by = "hold", "code"
        _send_to_person(belt, pid, reason)
    else:
        final, by = None, None
        desk = min(range(N_DESKS), key=lambda i: belt.desk_load[i])
        belt.desk_load[desk] += 1
        belt.pending_slow += 1
        routes.append(f"desk{desk}")
    belt.lanes[lane] += 1
    belt.lane_of[pid] = lane
    if lane == "auto":
        await belt.caption(pid, 3, n, "auto", f"Jev acts alone: {str(final).upper()}, Gemini is not called")
    elif lane == "human":
        await belt.caption(pid, 3, n, "human desk", "a person decides this one; the belt keeps moving")
    shown = {**decision, "action": final or "hold", "lane": lane}
    row = belt.score.add(parcel, shown, answers)
    calls.annotate(answers.get("call_id"), decision=shown["action"], why=decision["why"], outcome=row["outcome"],
                   confidence=decision["confidence"], lane=lane)
    belt.emit("decision", node="tick", id=pid, started=v["started"], ms=answers["ms"],
              replay=bool(answers.get("replay")), tokens=answers["input_tokens"], decision=shown,
              outcome=row["outcome"], truth=row["truth"], score=belt.score.snapshot(),
              claim_used=False, call_id=answers.get("call_id"),
              model=answers.get("model"), policy=policy.STATE["name"], policy_version=policy.version(),
              url=f"/api/photo/{pid}.jpg", declared=parcel["declared"])
    if final:
        belt.stream("decision", parcel_id=pid, final_action=final, decided_by=by, reason=decision["why"])
    # Jev sees damage -> Gemini reads that parcel's label for the claim (its own branch).
    if decision["damaged"] >= reflex.CLAIM_ON_DAMAGE and decision["model_choice"] in ("hold", "return"):
        belt.pending_slow += 1
        routes.append("claim")
    over = belt.index >= len(belt.parcels)
    routes.append("done" if over else "next")
    belt.emit_stats()
    return Event(output={"parcel_id": pid, "audit": audit}, route=routes,
                 state={"last": {"id": pid, "lane": lane, "action": final or "pending"}})


def check_claim(ctx: Context, node_input) -> Event:
    """A glance at the shared state after every parcel. Never waits."""
    belt = _belt(ctx)
    claim = ctx.state.get("claim")
    since = ctx.state.get("reading_since")
    waited = round(belt.now() - float(since), 1) if (since is not None and belt.reading) else None
    belt.emit("check", node="check_claim", ready=bool(claim), waited=waited)
    return Event(output="belt", route="again")


# ── Gemini again at the end, where prose belongs ────────────────────────────

class ShiftReport(BaseModel):
    headline: str = Field(description="Under 10 words.")
    report: str = Field(description="End-of-shift report in under 70 words, simple English.")


_lead_before, _lead_after, _lead_error = _llm_callbacks("shift_lead")
_lead_node_before, _lead_node_after = _agent_node_events("shift_lead")

shift_lead = LlmAgent(
    name="shift_lead",
    model=GEMINI_MODEL,
    description="Writes the end-of-shift report.",
    instruction=(
        "You are the shift lead at a parcel sorting hub. You get the shift log as JSON: each parcel, "
        "the action taken, and whether it matched the answer key, plus the lanes (auto = the fast model "
        "decided alone, gemini = second look, human = held for a person), how often Gemini was skipped, "
        "the claims filed and tool calls blocked, and the speed of the fast model. Write a short, upbeat "
        "end-of-shift report in simple English. Mention near-miss ships (should be 0), the lanes, claims "
        "filed, blocked actions, and how fast each decision was."
    ),
    output_schema=ShiftReport,
    output_key="shift_report",
    generate_content_config=types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(include_thoughts=True)),
    before_model_callback=_lead_before,
    after_model_callback=_lead_after,
    on_model_error_callback=_lead_error,
    before_agent_callback=_lead_node_before,
    after_agent_callback=_lead_node_after,
)


async def summarise(ctx: Context, node_input) -> dict:
    """Wait for second looks and label reads still in flight, so the report, the scorecard and the
    timeline all count them, and run_end really is the end of the run."""
    belt = _belt(ctx)
    if belt.pending_slow > 0:
        belt.emit("wait_slow", node="summarise", reason="Gemini still working (second looks / label reads)")
        deadline = time.perf_counter() + float(os.environ.get("BELT_FINAL_WAIT_SECONDS", "90"))
        while belt.pending_slow > 0 and time.perf_counter() < deadline:
            await asyncio.sleep(0.1)
    snap = belt.score.snapshot()
    belt.emit("summary_start", node="shift_lead", score=snap)
    st = belt.stats()
    return {"score": snap, "lanes": st["lanes"], "gemini_skipped": st["gemini_skipped"],
            "claims_filed": st["claims_filed"], "blocked_tools": st["blocked_tools"],
            "human_pending": st["human_pending"], "log": belt.score.rows}


def finish(ctx: Context, node_input) -> Event:
    belt = _belt(ctx)
    if hasattr(node_input, "model_dump"):
        node_input = node_input.model_dump()
    report = node_input if isinstance(node_input, dict) else {"headline": "", "report": str(node_input)}
    belt.emit("run_end", score=belt.score.snapshot(), report=report)
    belt.emit_stats()
    belt.stream("run_end", scorecard={**belt.score.snapshot(), **belt.stats()}, report=report)
    rec = calls.get(belt.last_llm_call.get("shift_lead") or "")
    if report.get("report") and rec and rec.get("live"):
        jev.replay_put("shift_lead", "last", report)
    return Event(message=f"{report.get('headline', '')}\n\n{report.get('report', '')}",
                 output=belt.score.snapshot(), state={"shift_report": report})


# ── the graphs ──────────────────────────────────────────────────────────────

def _belt_graph() -> Workflow:
    n = {f.__name__: _node(f) for f in (enter, tick, check_claim, read_label, claim_ready, rest, finish)}
    n["gate"] = _node(gate, rerun=True)                  # it runs second_look dynamically
    n["summarise"] = _node(summarise)
    desks = {f"desk{i}": _node(_make_desk(i), rerun=True) for i in range(N_DESKS)}
    return Workflow(
        name="belt",
        description="Jev judges every parcel; the gate escalates the unsure ones to Gemini or a person; "
                    "Gemini reads the labels of damaged parcels and proposes claims a code gate allows or blocks.",
        edges=[
            ("START", n["enter"]),
            (n["enter"], n["tick"]),
            (n["tick"], n["gate"]),
            (n["gate"], {"next": n["check_claim"], "done": n["summarise"], "claim": n["read_label"], **desks,
                         **{f"audit{i}": desks[f"desk{i}"] for i in range(N_DESKS)}}),
            (n["check_claim"], {"again": n["tick"]}),
            (n["read_label"], claims_clerk, n["claim_ready"]),
            (n["claim_ready"], {"retry": n["read_label"], "stored": n["rest"]}),
            (n["summarise"], shift_lead, n["finish"]),
        ],
    )


# Workflow sorts: Jev + Gemini + the floor manager. (Jev vs Gemini, mode 2, is belt/h2h.py.)
belt_workflow = _belt_graph()

root_agent = belt_workflow
