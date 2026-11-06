"""What Jev is asked about each parcel photo, and what the code does with the answer.

Same shape as stages/05-model-fights/app/reflex.py: typed questions out, one
action back. The model reads the photo; the code holds the policy.

All limits compare CONFIDENCE, not the top probability.
For a K-option Choice, confidence = (top - 1/K) / (1 - 1/K) is a good rule of thumb
(4 options: probability 0.6 -> confidence 0.47). The API returns the real value
in ChoiceAnswer.confidence and that is what we use.
"""

from __future__ import annotations

from typing import Any

from typesafe_sdk import Box, Choice, Noul, Score

# The standard policy. Words, not weights: the page's policy editor swaps these (belt/policy.py).
# ship/hold mention the declared contents, so the same photo can get a different answer for
# books than for glass (the "context test" on the page).
RESPONSES = {
    "ship": "The box is intact and closed, or it has only a light dent and the contents are sturdy "
            "(books, clothes, plastic). Send it on.",
    "retape": "The box is fine but the tape or a flap is open. Tape it and send it on.",
    "hold": "The box is crushed, torn, punctured or wet, or it is dented and the contents are fragile "
            "(glass, ceramics). A person must check it.",
    "return": "The box is destroyed or leaking. Send it back to the sender.",
}
CLAIM = "Damaged parcel and the claim packet is ready. File the damage claim now."

TRUST_CONFIDENCE = 0.40    # below this, Jev is guessing (unchanged from the workshop)
SEVERE_RISK = 1.5          # risk score at or above this = contents probably broken
SAFE_FALLBACK = "hold"     # what "play it safe" means on a belt
CLAIM_ON_DAMAGE = 0.60     # damaged at or above this, with a claim ready -> file it
AUTO_SHIP = 0.80           # NEW: only auto-ship when confidence is at least 0.80


def parcel_questions(claim_ready: bool, box: bool = True, policy: dict[str, str] | None = None) -> dict[str, Any]:
    """`policy` = the option descriptions (belt/policy.py, editable on the page). Default: RESPONSES."""
    policy = policy or {**RESPONSES, "file_claim": CLAIM}
    options = {k: policy.get(k, RESPONSES[k]) for k in RESPONSES}
    if claim_ready:
        options["file_claim"] = policy.get("file_claim", CLAIM)   # offered only when Gemini's packet is ready
    questions: dict[str, Any] = {
        "action": Choice(
            instructions=ACTION_INSTRUCTIONS,
            criteria=options,
        ),
        "damaged": Noul(instructions="Is the parcel in `photo` visibly crushed, torn, punctured, wet or leaking?"),
        "risk": Score(
            instructions="How likely is it that `declared_contents` are damaged, judging by `photo`?",
            criteria=["None: the box is intact.",
                      "Cosmetic: dents or scuffs; contents are probably fine.",
                      "Severe: contents are probably broken or leaking."],
        ),
    }
    if box:
        # Display only. Needs jev-1.14. Never gates an action.
        questions["where"] = Box(instructions="the damaged area of the parcel in `photo`")
    return questions


ACTION_INSTRUCTIONS = ("This parcel is on the sorting belt now, shown in `photo`, with contents "
                       "`declared_contents` and handling note `handling`. What should the sorter do?")


def action_question(policy: dict[str, str] | None = None) -> dict[str, Any]:
    """Head-to-head mode: only the decision, the four option texts, nothing else (no damaged/risk/Box).
    Gemini gets the same instruction and the same four texts (belt/h2h.py)."""
    policy = policy or RESPONSES
    return {"action": Choice(instructions=ACTION_INSTRUCTIONS,
                             criteria={k: policy.get(k, RESPONSES[k]) for k in RESPONSES})}


def plain(response: Any, ms: int, replay: bool = False) -> dict[str, Any]:
    """SDK response -> plain dict, the same shape the replay cache stores."""
    ans = response.answers
    out: dict[str, Any] = {
        "action": {"choice": ans["action"].choice, "confidence": float(ans["action"].confidence),
                   "probabilities": {k: float(v) for k, v in ans["action"].probabilities.items()}},
        "model": response.model,
        "input_tokens": int(response.usage.input_tokens or 0) if response.usage else 0,
        "output_tokens": int(response.usage.output_tokens or 0) if response.usage else 0,
        "ms": ms, "replay": replay,
    }
    if "damaged" in ans:
        out["damaged"] = {"noul": float(ans["damaged"].noul)}
    if "risk" in ans:
        out["risk"] = {"score": float(ans["risk"].score)}
    if "where" in ans:
        b = ans["where"]
        out["where"] = {"box": b.box.model_dump(), "confidence": b.confidence}
    return out


def choose(answers: dict[str, Any], claim_ready: bool, handling: str | None = "",
           trust: float | None = None, auto_ship: float | None = None) -> dict[str, Any]:
    """Plain answers in (see plain()), one action out. Four rules, all in code.

    `trust` / `auto_ship` default to TRUST_CONFIDENCE / AUTO_SHIP; the belt passes the runtime
    thresholds (belt/floor.py: abstain / auto) so the page's sliders move these rules too."""
    trust = TRUST_CONFIDENCE if trust is None else float(trust)
    auto_ship = AUTO_SHIP if auto_ship is None else float(auto_ship)
    a = answers["action"]
    confidence = float(a["confidence"])
    damaged = float(answers["damaged"]["noul"])
    risk = float(answers["risk"]["score"])
    action, fallback, why = a["choice"], False, "model choice"

    # Rule 1: unsure about a probably-broken box -> hold
    if confidence < trust and risk >= SEVERE_RISK:
        action, fallback, why = SAFE_FALLBACK, True, f"confidence {confidence:.2f} < {trust:.2f} and risk high"
    # Rule 2: spend the slow result
    if claim_ready and action in ("hold", "return") and damaged >= CLAIM_ON_DAMAGE:
        action, why = "file_claim", "claim packet ready + damaged"
    if action == "file_claim" and not claim_ready:
        action, why = "hold", "no claim packet yet"
    # Rule 3: only auto-ship when sure
    if action == "ship" and confidence < auto_ship:
        action, why = "spot_check", f"ship but confidence {confidence:.2f} < {auto_ship:.2f}"
    # Rule 4: shared state as policy. The slow branch saw FRAGILE -> never just retape.
    if action == "retape" and "fragile" in (handling or "").lower():
        action, why = "hold", "fragile: a person checks it"

    where = answers.get("where")
    return {
        "action": action, "model_choice": a["choice"], "why": why,
        "confidence": round(confidence, 3),
        "probabilities": {k: round(float(v), 3) for k, v in a["probabilities"].items()},
        "damaged": round(damaged, 3), "risk": round(risk, 3), "fallback": fallback,
        "box": where if (where and damaged >= CLAIM_ON_DAMAGE) else None,
    }
