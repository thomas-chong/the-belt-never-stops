"""LLM teaches, Jev serves: the teacher agent, as its own small ADK Workflow.

  START ─► teach_gather (code: the human lane + people's decisions + the policy now)
        ─► teacher (Gemini LlmAgent, output_schema=TeachProposal)
        ─► teach_store (code: validate, diff against the policy, store as a proposal)

The proposal is never applied here. A person approves it (POST /api/teach/{id}/approve), then
the policy version bumps and the next Jev calls use the new option texts (belt/floor.py approve()).
"""

from __future__ import annotations

import json

from google.adk.agents import LlmAgent
from google.adk.agents.context import Context
from google.adk.events.event import Event
from google.adk.workflow import Workflow
from google.genai import types
from pydantic import BaseModel, Field

from belt import engine, floor, policy
from belt.workflow import BELTS, GEMINI_MODEL, _agent_node_events, _llm_callbacks, _node

MAX_PHOTOS = 6


class OptionChange(BaseModel):
    option: str = Field(description="One of: ship, retape, hold, return, file_claim.")
    new_text: str = Field(description="The full new description for that option, under 350 characters. It "
                                      "names one clear visible sign, and no visible condition in it may also "
                                      "appear in any other option's description.")


class TeachProposal(BaseModel):
    rule_text: str = Field(description="The new rule in one plain sentence under 20 words, as a general rule "
                                       "about what is visible and the declared contents. No parcel ids. "
                                       "Example: 'A dented box with fragile contents is held for a person.'")
    changes: list[OptionChange] = Field(description="One or two option descriptions to rewrite (empty list if "
                                                    "the policy already matches what people decided). When a "
                                                    "condition moves into one option, rewrite the option it "
                                                    "came from too, so no condition sits in two options.")
    rationale: str = Field(description="Why, in under 80 words, citing what people decided and which two "
                                       "options Jev was split between. Say so if people disagreed with each "
                                       "other on similar parcels.")
    parcel_ids: list[str] = Field(description="The parcel ids this proposal is based on.")


def cases() -> list[dict]:
    """What the teacher sees: every decided human-lane parcel, with Jev's and Gemini's view."""
    out = []
    for item in floor.HUMAN.decided():
        j = item.get("jev") or {}
        out.append({"parcel_id": item["parcel_id"], "declared": item.get("declared"),
                    "why_held": item.get("reason"),
                    "jev": {"choice": j.get("choice"), "confidence": round(float(j.get("confidence") or 0), 3),
                            "probabilities": {k: round(float(v), 3) for k, v in (j.get("probabilities") or {}).items()},
                            "damaged": round(float(j.get("damaged") or 0), 3)},
                    "second_look": item.get("second_look"), "person_decided": item["action"]})
    return out


def teach_gather(ctx: Context, node_input) -> Event:
    rows = cases()
    pol = policy.current_options()
    bars = floor.effective_bars()
    text = ("PARCEL REVIEW for the teacher.\n"
            f"Current policy (version {policy.version()}), option -> description:\n"
            + json.dumps(pol, indent=1)
            + "\n\nThe target: Jev's confidence (its top probability) decides where a parcel goes. Under the "
            f"desk bar {bars['abstain']:.2f} it goes to a person; to leave the belt alone it needs at least "
            f"ship {bars['ship']:.2f} / retape {bars['retape']:.2f} / hold {bars['hold']:.2f}. "
            "Each case below gives jev.confidence and jev.probabilities over the options: the two highest "
            "probabilities are the two options Jev was split between."
            + "\n\nParcels the fast model was unsure about, and what a person decided:\n"
            + json.dumps(rows, indent=1)
            + "\n\nPhotos of some of these parcels follow, each after its parcel id.")
    parts = [types.Part(text=text)]
    files = {i["parcel_id"]: i.get("file") for i in floor.HUMAN.decided()}
    for row in rows[:MAX_PHOTOS]:
        f = files.get(row["parcel_id"])
        if f and (engine.ROOT / f).is_file():
            parts.append(types.Part(text=f"Photo of {row['parcel_id']} ({row['declared']}):"))
            parts.append(types.Part.from_bytes(data=(engine.ROOT / f).read_bytes(), mime_type="image/jpeg"))
    return Event(output=types.Content(role="user", parts=parts))


TEACHER_INSTRUCTION = (
    "You are the teacher for a fast vision model (Jev) on a parcel sorting belt. Jev does not learn "
    "from examples; it chooses between option descriptions written in plain English (the policy). "
    "You get the current policy and the parcels Jev was unsure about, with what a person decided, Jev's "
    "confidence and its probability for each option, and some photos. "
    "GOAL: on cases like these Jev picks what the person picked AND is sure of it (high confidence). "
    "Matching the person with low confidence still sends the parcel to a person, so being decisive matters. "
    "Propose a small, concrete rewrite of one or two option descriptions, without changing the meaning "
    "for ordinary parcels. RULES: "
    "(1) Option descriptions must not overlap: each visible condition belongs to exactly one option. If you "
    "add a condition to one option, remove it from every other option (rewrite that option too). Overlap "
    "splits Jev's probability between options and lowers its confidence. "
    "(2) Give each option one clear visible sign that tells it apart from the others. "
    "(3) Never move fragile, glass, ceramic or porcelain contents toward ship, and never call such contents "
    "sturdy. "
    "(4) Do not broaden ship. "
    "(5) Use the probabilities given per case: prefer sharpening the boundary between the two options Jev "
    "was split between over rewriting other options. "
    "(6) If the people's decisions disagree with each other on similar parcels, say so in rationale and "
    "change less. "
    "Write general rules: describe what is visible on the box and the kind of declared contents. Never put "
    "a parcel id in an option text or in rule_text. Keep each description under 350 characters. Do not add "
    "or remove options. Also write rule_text: the change as one plain sentence under 20 words that anyone "
    "in the room understands. List the parcel ids you used in parcel_ids only."
)

_t_before, _t_after, _t_error = _llm_callbacks("teacher")
_t_node_before, _t_node_after = _agent_node_events("teacher")

teacher = LlmAgent(
    name="teacher",
    model=GEMINI_MODEL,
    description="Proposes a change to the policy text Jev chooses between, from the human lane.",
    instruction=TEACHER_INSTRUCTION,
    output_schema=TeachProposal,
    generate_content_config=types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(include_thoughts=True)),
    before_model_callback=_t_before,
    after_model_callback=_t_after,
    on_model_error_callback=_t_error,
    before_agent_callback=_t_node_before,
    after_agent_callback=_t_node_after,
)


def teach_store(ctx: Context, node_input) -> Event:
    belt = BELTS.get(ctx.session.id)
    data = node_input.model_dump() if hasattr(node_input, "model_dump") else dict(node_input or {})
    call_id = belt.last_llm_call.get("teacher") if belt else None
    from belt import calls  # noqa: PLC0415
    rec = calls.get(call_id or "")
    live = bool(rec and rec.get("live"))
    try:
        prop = floor.new_proposal(data.get("changes") or [], data.get("rationale", ""),
                                  data.get("parcel_ids") or [], live=live, call_id=call_id,
                                  rule_text=data.get("rule_text") or "")
    except ValueError as exc:
        if belt:
            belt.stream("teach_error", error=str(exc), call_id=call_id)
        return Event(output={"error": str(exc)})
    if live:
        from belt import jev  # noqa: PLC0415
        jev.replay_put("teacher", "last", data)
    if belt:
        belt.stream("teach_proposal", proposal_id=prop["proposal_id"], diff=prop["diff"],
                    diff_text=prop["diff_text"], rationale=prop["rationale"], parcel_ids=prop["parcel_ids"],
                    live=live, call_id=call_id, base_version=prop["base_version"], rule_text=prop["rule_text"],
                    evidence=prop["evidence"], status=prop["status"], warnings=prop["warnings"])
    return Event(output={"proposal_id": prop["proposal_id"]})


_gather_node, _store_node = _node(teach_gather), _node(teach_store)
teach_workflow = Workflow(
    name="teach",
    description="Gemini looks at the human lane and proposes a policy text change; a person approves it.",
    edges=[("START", _gather_node), (_gather_node, teacher, _store_node)],
)
