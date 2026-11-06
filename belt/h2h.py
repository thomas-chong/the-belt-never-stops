"""Mode 2, "Jev vs Gemini: same parcel, same question". A fair head-to-head, as one ADK Workflow.

  START ─► h2h_enter ─► h2h_tick ─► h2h_next ─► h2h_tick ─► … ─► h2h_finish
                          │
                          ├─ Jev 1.14       (typesafe-sdk, action question only)    ┐ started at the
                          └─ gemini_reflex  (ADK LlmAgent, Gemini, ctx.run_node)     ┘ same moment

For every parcel both models get the identical photo, station, declared contents, handling note,
question text and the four policy option texts (ship / retape / hold / return), at the same time.
Jev answers with calibrated probabilities. Gemini answers with typed JSON {action, probabilities,
confidence, reason}; its probabilities and confidence are stated by the LLM (verbalized), not
calibrated. No thresholds, no lanes, no code rules on top: each model's own top choice is its answer,
graded against the answer key in the manifest. Latency for both sides is measured the same way:
wall clock from dispatch to a parsed answer, in this process.
"""

from __future__ import annotations

import asyncio
import math
import time
from typing import Literal

from google.adk.agents import LlmAgent
from google.adk.agents.context import Context
from google.adk.events.event import Event
from google.adk.workflow import Workflow
from google.genai import types
from pydantic import BaseModel, Field

from belt import calls, engine, floor, gemma, jev, policy, reflex
from belt.workflow import (GEMINI_MODEL, _agent_node_events, _belt, _llm_callbacks, _node, forced_replay,
                           photo_url)

ACTIONS = ("ship", "retape", "hold", "return")
# Calibration bins on the stated / calibrated probability that the chosen action is right.
BINS = ((0.0, 0.6), (0.6, 0.8), (0.8, 0.95), (0.95, 1.0))


# ── Gemini's side: an ADK LlmAgent with a typed answer ───────────────────────

class OptionProbabilities(BaseModel):
    ship: float = Field(description="Probability (0 to 1) that ship is the right action.")
    retape: float = Field(description="Probability (0 to 1) that retape is the right action.")
    hold: float = Field(description="Probability (0 to 1) that hold is the right action.")
    return_: float = Field(alias="return", description="Probability (0 to 1) that return is the right action.")

    model_config = {"populate_by_name": True}


class ReflexAnswer(BaseModel):
    action: Literal["ship", "retape", "hold", "return"] = Field(description="The option you choose.")
    probabilities: OptionProbabilities = Field(description="A probability for every option; they sum to 1.")
    confidence: float = Field(description="Your probability (0 to 1) that your chosen action is the correct one.")
    reason: str = Field(description="One sentence under 25 words: what in the photo decided it.")


_r_before, _r_after, _r_error = _llm_callbacks("gemini_reflex")
_r_node_before, _r_node_after = _agent_node_events("gemini_reflex")

REFLEX_INSTRUCTION = (
    "You decide one parcel on a sorting belt. You get the parcel photo, the station, the declared "
    "contents, the handling note and one question with four options (ship, retape, hold, return), each "
    "described by its policy text. Choose the option whose text fits this parcel best. Give a probability "
    "for every option (they sum to 1), your confidence (0 to 1) that your chosen action is the correct one, "
    "and one short reason."
)

gemini_reflex = LlmAgent(
    name="gemini_reflex",
    model=GEMINI_MODEL,
    description="Makes the same per-parcel decision as Jev, for the head-to-head.",
    instruction=REFLEX_INSTRUCTION,
    output_schema=ReflexAnswer,
    # Same generation settings as every other Gemini agent in this demo (thought summaries on).
    generate_content_config=types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(include_thoughts=True)),
    before_model_callback=_r_before,
    after_model_callback=_r_after,
    on_model_error_callback=_r_error,
    before_agent_callback=_r_node_before,
    after_agent_callback=_r_node_after,
)


def question_text(pid: str, declared: str, options: dict[str, str]) -> str:
    """The same inputs Jev gets in `state` + `questions`, written out for Gemini, word for word."""
    return (f"PARCEL {pid}\n"
            f"station: {jev.STATION}\n"
            f"declared_contents: {declared}\n"
            f"handling: none noted\n"
            f"photo: the attached image\n\n"
            f"Question: {reflex.ACTION_INSTRUCTIONS}\n"
            "Options (option: policy text):\n" + "\n".join(f"- {k}: {options[k]}" for k in ACTIONS))


def reflex_content(pid: str, declared: str, image: bytes, options: dict[str, str]) -> types.Content:
    return types.Content(role="user", parts=[types.Part(text=question_text(pid, declared, options)),
                                             types.Part.from_bytes(data=image, mime_type="image/jpeg")])


# ── the scoreboard (pure, unit-tested) ───────────────────────────────────────

def p95(xs: list[float]) -> float | None:
    """Nearest-rank 95th percentile."""
    if not xs:
        return None
    s = sorted(xs)
    return s[max(0, math.ceil(0.95 * len(s)) - 1)]


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def calibration(rows: list[dict], side: str) -> list[dict]:
    """Bins of the probability a side gave its own choice vs how often that choice was correct."""
    out = []
    for i, (lo, hi) in enumerate(BINS):
        last = i == len(BINS) - 1
        pick = [r[side] for r in rows if r[side].get("action") and r[side].get("p_chosen") is not None
                and lo <= r[side]["p_chosen"] and (r[side]["p_chosen"] <= hi if last else r[side]["p_chosen"] < hi)]
        n = len(pick)
        out.append({"lo": lo, "hi": hi, "n": n,
                    "mean_p": round(_mean([p["p_chosen"] for p in pick]), 3) if n else None,
                    "accuracy": round(sum(1 for p in pick if p["outcome"] == "correct") / n, 3) if n else None})
    return out


def side_stats(rows: list[dict], side: str) -> dict:
    n = len(rows)
    got = [r[side] for r in rows]
    answered = [g for g in got if g.get("action")]
    ms = [float(g["ms"]) for g in answered if g.get("ms") is not None]
    cost = sum(float(g.get("cost") or 0) for g in got)
    count = lambda k: sum(1 for g in answered if g.get("outcome") == k)  # noqa: E731
    return {"parcels": n, "answered": len(answered), "errors": n - len(answered),
            "correct": count("correct"), "safe": count("safe"), "wrong": count("wrong"),
            "near_miss": count("near_miss"),
            "accuracy": round(count("correct") / n, 3) if n else None,
            "ms_mean": round(_mean(ms)) if ms else None, "ms_p95": round(p95(ms)) if ms else None,
            "tokens_in_mean": round(_mean([float(g.get("tokens_in") or 0) for g in answered])) if answered else None,
            "tokens_out_mean": round(_mean([float(g.get("tokens_out") or 0) for g in answered])) if answered else None,
            "cost_total": round(cost, 6), "cost_per_1k": round(cost / n * 1000, 4) if n else None,
            "live_calls": sum(1 for g in got if g.get("live")),
            "mean_p_chosen": round(_mean([g["p_chosen"] for g in answered if g.get("p_chosen") is not None]) or 0, 3)
            if answered else None}


def scoreboard(rows: list[dict]) -> dict:
    """Running head-to-head numbers from the per-parcel rows (see h2h_result in belt/API.md)."""
    n = len(rows)
    both = [r for r in rows if r["jev"].get("action") and r["gemini"].get("action")]
    agree = sum(1 for r in both if r["jev"]["action"] == r["gemini"]["action"])
    jev_s, gem_s = side_stats(rows, "jev"), side_stats(rows, "gemini")
    has_gemma = bool(rows) and all("gemma" in r for r in rows)
    gma_s = side_stats(rows, "gemma") if has_gemma else None
    return {"parcels": n, "both_answered": len(both), "agree": agree,
            "agreement_rate": round(agree / len(both), 3) if both else None,
            "jev": jev_s, "gemini": gem_s, **({"gemma": gma_s} if gma_s else {}),
            "gemma_wait_s": round(gma_s["ms_mean"] / 1000, 2) if gma_s and gma_s["ms_mean"] is not None else None,
            # "if Gemini were the reflex, the belt would wait X s per parcel" (mean answer latency)
            "gemini_wait_s": round(gem_s["ms_mean"] / 1000, 2) if gem_s["ms_mean"] is not None else None,
            "jev_wait_s": round(jev_s["ms_mean"] / 1000, 3) if jev_s["ms_mean"] is not None else None,
            "calibration": {"jev": calibration(rows, "jev"), "gemini": calibration(rows, "gemini"),
                            **({"gemma": calibration(rows, "gemma")} if has_gemma else {})},
            "confidence_kind": {"jev": "calibrated probability (Jev's probability for its chosen option)",
                                "gemini": "stated by the LLM (verbalized confidence in its JSON answer)"},
            "prices": {"jev_in_per_m": calls.PRICE_PER_MILLION_INPUT, "jev_out_per_m": 0.0,
                       "gemini_in_per_m": floor.GEMINI_PRICE_IN, "gemini_out_per_m": floor.GEMINI_PRICE_OUT,
                       "gemini_source": floor.GEMINI_PRICE_SOURCE, "gemma_per_hour": gemma.per_hour()}}


# ── the two sides of one parcel ──────────────────────────────────────────────

def _jev_side(out: dict, wall_ms: int, truth: dict) -> dict:
    a = out.get("action") or {}
    probs = {k: round(float(v), 3) for k, v in (a.get("probabilities") or {}).items()}
    choice = a.get("choice")
    tin, tout = int(out.get("input_tokens") or 0), int(out.get("output_tokens") or 0)
    live = not out.get("replay")
    return {"call_id": out.get("call_id"), "action": choice, "probabilities": probs,
            "p_chosen": probs.get(choice), "confidence": round(float(a.get("confidence") or 0), 3),
            # the same clock for both sides; a replayed answer reports the latency recorded with it
            "ms": wall_ms if live else int(out.get("ms") or 0), "call_ms": out.get("ms"),
            "tokens_in": tin, "tokens_out": tout,
            "cost": round(tin * calls.PRICE_PER_MILLION_INPUT / 1_000_000, 7),
            "live": live, "model": out.get("model"), "outcome": engine.grade(truth, choice)}


def _gemini_side(answer: dict, rec: dict | None, wall_ms: int, truth: dict, pid: str) -> dict:
    probs_raw = answer.get("probabilities") or {}
    probs = {k: round(float(probs_raw.get(k, probs_raw.get(f"{k}_", 0)) or 0), 3) for k in ACTIONS}
    choice = answer.get("action")
    live = bool(rec and rec.get("live"))
    if live:
        tin, tout, tth = rec.get("input_tokens") or 0, rec.get("output_tokens") or 0, rec.get("thought_tokens") or 0
        ms = wall_ms
    else:
        u = jev.replay_get("gemini_reflex_usage", pid) or {}
        tin, tout, tth = u.get("tokens_in") or 0, u.get("tokens_out") or 0, u.get("thought_tokens") or 0
        ms = int(u.get("ms") or 0) or None
    conf = float(answer.get("confidence") or 0)
    return {"call_id": rec.get("id") if rec else None, "action": choice, "probabilities": probs,
            # stated by the LLM; clamped to [0, 1] for binning only
            "confidence": round(conf, 3), "p_chosen": round(min(1.0, max(0.0, conf)), 3),
            "reason": str(answer.get("reason") or "")[:300], "ms": ms, "call_ms": rec.get("ms") if rec else None,
            "tokens_in": int(tin), "tokens_out": int(tout) + int(tth), "thought_tokens": int(tth),
            "cost": floor.gemini_cost(tin, tout, tth), "live": live, "model": GEMINI_MODEL,
            "outcome": engine.grade(truth, choice) if choice in ACTIONS else "wrong"}


def _gemma_side(out: dict, truth: dict) -> dict:
    probs = {k: round(float(out.get("probabilities", {}).get(k, 0)), 3) for k in ACTIONS}
    choice = out.get("action")
    ms = out.get("ms")
    return {"call_id": out.get("call_id"), "action": choice, "probabilities": probs,
            "p_chosen": probs.get(choice), "confidence": round(float(out.get("confidence") or 0), 3),
            "ms": ms, "call_ms": ms, "tokens_in": int(out.get("tokens_in") or 0),
            "tokens_out": int(out.get("tokens_out") or 0),
            # GPU time at the instance price: what this answer cost if the GPU did nothing else
            "cost": round((ms or 0) / 3_600_000 * gemma.per_hour(), 7),
            "live": bool(out.get("live")), "model": gemma.LABEL,
            "outcome": engine.grade(truth, choice) if choice in ACTIONS else "wrong"}


# ── the graph nodes ──────────────────────────────────────────────────────────

def h2h_enter(ctx: Context, node_input) -> Event:
    belt = _belt(ctx)
    belt.h2h_rows = []
    belt.stream("run_start", mode="h2h", total=len(belt.parcels), jev_model=jev.MODEL, gemini_model=GEMINI_MODEL,
                replay_jev=jev.force_replay(), replay_gemini=forced_replay(), pace=belt.pace,
                policy_version=policy.version(), policy_name=policy.STATE["name"],
                prices=scoreboard([])["prices"], gemma_model=gemma.LABEL if gemma.enabled() else None)
    if gemma.enabled():
        belt.gemma_warm = asyncio.ensure_future(gemma.warm())   # a scaled-to-zero GPU starts booting now
    return Event(output="h2h", state={"tick": 0})


async def h2h_tick(ctx: Context, node_input) -> Event:
    """One parcel: Jev and gemini_reflex at the same moment, same inputs. Waits for both (it is a race)."""
    belt = _belt(ctx)
    await asyncio.sleep(belt.pace)
    parcel = belt.parcels[belt.index]
    belt.index += 1
    pid, declared, truth = parcel["id"], parcel["declared"], parcel["truth"]
    belt.stream("parcel", parcel_id=pid, photo_url=photo_url(pid), declared=declared, index=belt.index,
                total=len(belt.parcels), credit=parcel.get("credit"))
    image = (engine.ROOT / parcel["file"]).read_bytes()
    options = policy.current_options()          # one snapshot of the policy for both sides

    async def jev_side() -> dict:
        t0 = time.perf_counter()
        try:
            out = await jev.judge_photo(belt.jev, pid, image, declared, None, claim_ready=False, purpose="head-to-head",
                                        options=options, photo_url=photo_url(pid), action_only=True)
            side = _jev_side(out, round((time.perf_counter() - t0) * 1000), truth)
        except Exception as exc:  # noqa: BLE001 - a failed side is shown, never invented
            side = {"action": None, "error": f"{type(exc).__name__}: {str(exc)[:160]}", "live": False, "cost": 0,
                    "outcome": None}
        belt.stream("h2h_answer", side="jev", parcel_id=pid, **side)
        return side

    async def gemini_side() -> dict:
        t0 = time.perf_counter()
        try:
            out = await ctx.run_node(gemini_reflex, node_input=reflex_content(pid, declared, image, options),
                                     run_id=f"h2h-{pid}")
            wall = round((time.perf_counter() - t0) * 1000)
            answer = out.model_dump(by_alias=True) if hasattr(out, "model_dump") else dict(out or {})
            rec = calls.get(belt.last_llm_call.get("gemini_reflex") or "")
            side = _gemini_side(answer, rec, wall, truth, pid)
            if side["live"]:
                jev.replay_put("gemini_reflex", pid, answer)
                jev.replay_put("gemini_reflex_usage", pid, {"tokens_in": side["tokens_in"],
                                                            "tokens_out": side["tokens_out"] - side["thought_tokens"],
                                                            "thought_tokens": side["thought_tokens"], "ms": side["ms"]})
        except Exception as exc:  # noqa: BLE001
            side = {"action": None, "error": f"{type(exc).__name__}: {str(exc)[:160]}", "live": False, "cost": 0,
                    "outcome": None}
        belt.stream("h2h_answer", side="gemini", parcel_id=pid, **side)
        return side

    async def gemma_side() -> dict:
        try:
            side = _gemma_side(await gemma.judge(pid, declared, image, options, photo_url(pid)), truth)
        except Exception as exc:  # noqa: BLE001
            side = {"action": None, "error": str(exc)[:200], "live": False, "cost": 0, "outcome": None,
                    "model": gemma.LABEL}
        belt.stream("h2h_answer", side="gemma", parcel_id=pid, **side)
        return side

    sides = [jev_side(), gemini_side()] + ([gemma_side()] if gemma.enabled() else [])
    j, g, *rest = await asyncio.gather(*sides)
    row = {"parcel_id": pid, "declared": declared, "truth": truth["action"], "jev": j, "gemini": g,
           "agree": bool(j.get("action") and j.get("action") == g.get("action"))}
    if rest:
        row["gemma"] = rest[0]
    belt.h2h_rows.append(row)
    belt.stream("h2h_result", **row)
    belt.stream("h2h_stats", **scoreboard(belt.h2h_rows))
    return Event(output={"parcel_id": pid}, state={"tick": belt.index})


def h2h_next(ctx: Context, node_input) -> Event:
    belt = _belt(ctx)
    return Event(output="h2h", route="done" if belt.index >= len(belt.parcels) else "again")


def h2h_finish(ctx: Context, node_input) -> Event:
    belt = _belt(ctx)
    board = scoreboard(belt.h2h_rows)
    belt.stream("run_end", scorecard=board, report=None)
    return Event(output=board, state={"h2h": board})


def _h2h_graph() -> Workflow:
    n = {f.__name__: _node(f) for f in (h2h_enter, h2h_next, h2h_finish)}
    n["h2h_tick"] = _node(h2h_tick, rerun=True)       # it runs gemini_reflex dynamically
    return Workflow(
        name="belt_head_to_head",
        description="Jev and a Gemini agent get the same parcel and the same question at the same time.",
        edges=[
            ("START", n["h2h_enter"]),
            (n["h2h_enter"], n["h2h_tick"]),
            (n["h2h_tick"], n["h2h_next"]),
            (n["h2h_next"], {"again": n["h2h_tick"], "done": n["h2h_finish"]}),
        ],
    )


h2h_workflow = _h2h_graph()
