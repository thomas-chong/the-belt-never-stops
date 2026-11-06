"""Run one belt Workflow with ADK's Runner and stream every event to a callback.

Used by the web server (SSE to the browser) and by scripts/belt_run.py (terminal).
Each ADK event becomes {"type": "adk", "author": ..., "node": ..., "partial": ...};
partial events from the Gemini agents carry the streamed text, so the page can
show Gemini "thinking" while the belt keeps moving.
"""

from __future__ import annotations

from typing import Callable

from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import InMemoryRunner
from google.genai import types

from belt import env  # noqa: F401  (loads .env, sets Vertex defaults)
from belt import jev
from belt.workflow import BELTS, LAST, Belt, belt_workflow

GEMINI_AGENTS = {"claims_clerk", "shift_lead", "second_look", "teacher", "gemini_reflex"}


def _thought(event) -> str:
    if not event.content or not event.content.parts:
        return ""
    return "".join(p.text or "" for p in event.content.parts if p.text and getattr(p, "thought", False))


def _text(event) -> str:
    if not event.content or not event.content.parts:
        return ""
    return "".join(p.text or "" for p in event.content.parts if p.text and not getattr(p, "thought", False))


async def run_workflow(mode: str, emit: Callable[[dict], None], limit: int | None = None,
                       pace: float | None = None, stream: Callable[[dict], None] | None = None,
                       seed: bool | str = False, parcels: list[dict] | None = None, walk: bool = False) -> dict:
    """mode: "workflow" (Jev + Gemini + the floor manager) or "h2h" (Jev vs Gemini, belt/h2h.py).
    `emit` gets the original page events, `stream` the API contract events (belt/API.md).
    Gemini calls are recorded and closed by the ADK model callbacks in belt/workflow.py.
    `parcels` = an explicit, ordered parcel list (a named set or ids, belt/sets.py); it wins over `limit`.
    `walk` = mode 3 only: parcel 1 walks the graph slowly, one caption step at a time."""
    if mode == "h2h":
        from belt.h2h import h2h_workflow  # noqa: PLC0415
        workflow = h2h_workflow
    elif mode == "workflow":
        workflow = belt_workflow
    else:
        raise ValueError(f"unknown mode {mode!r} (workflow | h2h)")
    runner = InMemoryRunner(agent=workflow, app_name="belt")
    session = await runner.session_service.create_session(app_name="belt", user_id="stage")
    belt = Belt(emit, mode, limit, pace, stream=stream, seed=seed, parcels=parcels, walk=walk)
    BELTS[session.id] = belt
    LAST["belt"] = belt
    streamed: dict[str, str] = {}
    thoughts: dict[str, str] = {}
    try:
        msg = types.Content(role="user", parts=[types.Part(text="start the belt")])
        config = RunConfig(streaming_mode=StreamingMode.SSE)
        async for event in runner.run_async(user_id="stage", session_id=session.id, new_message=msg,
                                            run_config=config):
            author = event.author or ""
            if (event.custom_metadata or {}).get("belt_skipped"):
                continue                       # second_look skipped by its callback: no Gemini call
            node = (event.node_info.path or "") if event.node_info else ""
            text = _text(event)
            thought = _thought(event) if event.partial else ""
            out = {"type": "adk", "t": belt.now(), "author": author, "node": node,
                   "partial": bool(event.partial), "keys": sorted((event.actions.state_delta or {}).keys())}
            if author in GEMINI_AGENTS and thought:
                out["thought"] = thought
                thoughts[author] = thoughts.get(author, "") + thought
            if author in GEMINI_AGENTS and text:
                if event.partial:
                    streamed[author] = streamed.get(author, "") + text
                    out["text"] = text
                else:
                    out["final_text"] = text
                    streamed[author] = ""
                usage = event.usage_metadata
                if usage and not event.partial and usage.total_token_count:
                    out["gemini_tokens"] = int(usage.total_token_count)
                if not event.partial:
                    out["call_id"] = (belt.gem_calls.get(author) or {}).get("id")
                    thoughts.pop(author, None)
            emit(out)
        final = await runner.session_service.get_session(app_name="belt", user_id="stage", session_id=session.id)
        return {"score": belt.score.snapshot(), "report": final.state.get("shift_report") if final else None}
    finally:
        await jev.aclose(belt.jev)
        BELTS.pop(session.id, None)


async def run_teach(stream: Callable[[dict], None] | None = None) -> dict:
    """Run the teacher Workflow once (belt/teach.py). Returns the stored proposal (or an error)."""
    from belt import floor  # noqa: PLC0415
    from belt.teach import teach_workflow  # noqa: PLC0415
    runner = InMemoryRunner(agent=teach_workflow, app_name="teach")
    session = await runner.session_service.create_session(app_name="teach", user_id="stage")
    sink = Belt(lambda e: None, "teach", limit=0, stream=stream, make_client=False)
    BELTS[session.id] = sink
    before = set(floor.PROPOSALS)
    try:
        msg = types.Content(role="user", parts=[types.Part(text="teach")])
        async for _event in runner.run_async(user_id="stage", session_id=session.id, new_message=msg,
                                             run_config=RunConfig(streaming_mode=StreamingMode.SSE)):
            pass
    finally:
        BELTS.pop(session.id, None)
    new = [floor.PROPOSALS[k] for k in floor.PROPOSALS if k not in before]
    if not new:
        raise RuntimeError("the teacher made no valid proposal (see the stream for teach_error)")
    return new[-1]
