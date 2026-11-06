"""The belt web page and its API. One FastAPI app, events to the browser over SSE.

  uv run python -m belt.server [--host 127.0.0.1] [--port 8095]     (or: scripts/belt.sh)
  BELT_HOST / BELT_PORT set the defaults. Use --host 0.0.0.0 only on a network you trust.

Modes on the page: 1 You sort / 2 Jev vs Gemini (head-to-head, ADK) / 3 Workflow sorts (Jev + Gemini, ADK).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from belt import env  # noqa: F401
from belt import calls, engine, floor, jev, label, photos, policy, reflex, sets
from belt.run import run_teach, run_workflow

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "belt" / "static"
DIST = ROOT / "web" / "dist"          # the new front end, when it has been built
app = FastAPI(title="The belt never stops")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class Bus:
    """Fan one stream of events out to every open page."""

    def __init__(self) -> None:
        self.queues: set[asyncio.Queue] = set()
        self.history: list[dict] = []

    def emit(self, event: dict) -> None:
        self.history.append(event)
        self.history = self.history[-400:]
        for q in list(self.queues):
            q.put_nowait(event)


BUS = Bus()                            # original page events  -> GET /api/events (belt/static)
STREAM = Bus()                         # API contract events   -> GET /api/stream (web/, see belt/API.md)
RUN: dict = {"task": None, "mode": None}
TEACH: dict = {"task": None}


def stream(event_type: str, /, **data) -> None:
    STREAM.emit({"type": event_type, "ts": round(time.time(), 3), **data})
calls.LISTENERS.append(BUS.emit)          # every model call shows in the page's call log


def _parcel(pid: str) -> dict:
    p = engine.find_parcel(pid)
    if p is None:
        raise HTTPException(404, "no such parcel")
    return p


def _photo_file(pid: str) -> Path:
    """A parcel photo, or a placeholder stand-in (DEMO-*) for the context test and the policy editor."""
    if pid.startswith("DEMO-"):
        path = engine.PLACEHOLDER_DIR / f"{pid}.jpg"
        if path.is_file() and path.parent == engine.PLACEHOLDER_DIR:
            return path
        raise HTTPException(404, "no such photo")
    return ROOT / _parcel(pid)["file"]


def demo_photos() -> list[dict]:
    """Photos offered in the context test and the policy editor: the demo stand-ins, then the belt."""
    out = []
    for pid, (kind, _seed, declared) in photos.DEMO.items():
        if (engine.PLACEHOLDER_DIR / f"{pid}.jpg").is_file():
            out.append({"id": pid, "url": f"/api/photo/{pid}.jpg", "declared": declared, "kind": kind})
    out += [{"id": p["id"], "url": f"/api/photo/{p['id']}.jpg", "declared": p["declared"], "kind": p.get("kind")}
            for p in engine.parcels()]
    return out


def _short(out: dict, decision: dict) -> dict:
    return {"call_id": out.get("call_id"), "ms": out.get("ms"), "model": out.get("model"),
            "live": not out.get("replay"), "input_tokens": out.get("input_tokens"), "decision": decision}


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    """The built front end (web/dist) when it exists, else the original page (belt/static)."""
    built = DIST / "index.html"
    return built.read_text() if built.is_file() else (STATIC / "index.html").read_text()


@app.get("/legacy", response_class=HTMLResponse)
def legacy_index() -> str:
    """The original page, always."""
    return (STATIC / "index.html").read_text()


@app.get("/api/health")
def health() -> dict:
    from belt.workflow import GEMINI_MODEL, TICK_SECONDS  # noqa: PLC0415
    return {"ok": True, "jev_model": jev.MODEL, "gemini_model": GEMINI_MODEL, "replay_forced": jev.force_replay(),
            "gemini_price": {"in_per_m": floor.GEMINI_PRICE_IN, "out_per_m": floor.GEMINI_PRICE_OUT,
                             "source": floor.GEMINI_PRICE_SOURCE},
            "running": bool(RUN["task"] and not RUN["task"].done()), "mode": RUN["mode"],
            "pace": TICK_SECONDS, "photos": engine.photo_source()}


@app.get("/api/manifest")
def manifest() -> dict:
    return {"parcels": [{"id": p["id"], "url": f"/api/photo/{p['id']}.jpg", "declared": p["declared"],
                         "credit": p.get("credit")} for p in engine.parcels()],
            "photos": engine.photo_source()}


@app.get("/api/photo-source")
def photo_source() -> dict:
    return engine.photo_source()


@app.get("/api/photo/{pid}.jpg")
def photo(pid: str) -> FileResponse:
    return FileResponse(_photo_file(pid), media_type="image/jpeg")


@app.get("/api/photos")
def photos_for_demos() -> dict:
    return {"photos": demo_photos()}


@app.get("/api/photos/{file}")
def photo_file(file: str) -> FileResponse:
    """Contract photo URL: /api/photos/P-0101.jpg (also the DEMO-* stand-ins)."""
    if not file.endswith(".jpg") or "/" in file or ".." in file:
        raise HTTPException(404, "no such photo")
    return FileResponse(_photo_file(file[: -len(".jpg")]), media_type="image/jpeg")


# ── proof of inference: the call log and the Inspector ──────────────────────

@app.get("/api/calls")
def call_log(n: int = 120) -> dict:
    return {"calls": calls.recent(max(1, min(n, 400)))}


@app.get("/api/inspect/{call_id}")
@app.get("/api/call/{call_id}")
def call_detail(call_id: str) -> dict:
    rec = calls.get(call_id)
    if rec is None:
        raise HTTPException(404, "no such call (the server keeps the last 400)")
    return {k: v for k, v in rec.items() if k != "t_start"}


# ── why not YOLO: the context test and the policy editor ───────────────────

@app.post("/api/context-test")
async def context_test(request: Request) -> dict:
    """Same photo, two declared contents, two Jev calls at the same time, same policy, same code."""
    body = await request.json()
    pid = body.get("photo") or "DEMO-DENTED"
    texts = [str(body.get("a") or "Paperback books, 3")[:120], str(body.get("b") or "Glass vase, 2 pcs")[:120]]
    path = _photo_file(pid)
    c = jev.client()
    try:
        outs = await asyncio.gather(*[
            jev.judge_photo(c, pid, path, text, None, claim_ready=False, purpose=f"context {tag}",
                            photo_url=f"/api/photo/{pid}.jpg")
            for tag, text in zip("AB", texts)])
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    finally:
        await jev.aclose(c)
    sides = []
    for tag, text, out in zip("AB", texts, outs):
        d = reflex.choose(out, claim_ready=False, handling=None)
        calls.annotate(out.get("call_id"), decision=d["action"], why=d["why"], confidence=d["confidence"])
        sides.append({"tag": tag, "declared": text, **_short(out, d)})
    result = {"photo": pid, "url": f"/api/photo/{pid}.jpg", "policy": policy.STATE["name"],
              "policy_version": policy.version(), "sides": sides,
              "different": sides[0]["decision"]["action"] != sides[1]["decision"]["action"]}
    BUS.emit({"type": "context", **result})
    stream("context_test", **result)
    return result


@app.get("/api/policy")
def get_policy() -> dict:
    return policy.public()


@app.post("/api/policy")
async def set_policy(request: Request) -> dict:
    """Body: {"preset": "peak"} or {"options": {"ship": "...", ...}, "name": "..."}. Effective on the next call."""
    body = await request.json()
    try:
        state = policy.apply(options=body.get("options"), preset=body.get("preset"), name=body.get("name"))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    BUS.emit({"type": "policy", **state})
    stream("policy_version", version=state["version"], policy=_policy_brief(state))
    return state


def _policy_brief(state: dict) -> dict:
    return {"name": state["name"], "preset": state["preset"], "options": state["options"],
            "changed": state["changed"]}


@app.post("/api/policy/probe")
async def probe(request: Request) -> dict:
    """One live Jev call on one photo under the policy in force right now."""
    body = await request.json()
    pid = body.get("photo") or "DEMO-BATTERY"
    path = _photo_file(pid)
    declared = str(body.get("declared") or next((p["declared"] for p in demo_photos() if p["id"] == pid),
                                                 "Unknown contents"))[:120]
    c = jev.client()
    try:
        out = await jev.judge_photo(c, pid, path, declared, None, claim_ready=False, purpose="policy probe",
                                    photo_url=f"/api/photo/{pid}.jpg")
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    finally:
        await jev.aclose(c)
    d = reflex.choose(out, claim_ready=False, handling=None)
    calls.annotate(out.get("call_id"), decision=d["action"], why=d["why"], confidence=d["confidence"])
    return {"photo": pid, "url": f"/api/photo/{pid}.jpg", "declared": declared, "policy": policy.STATE["name"],
            "policy_version": policy.version(), **_short(out, d), "first_decision_s": policy.STATE["first_decision_s"]}


@app.get("/api/label/{index}.png")
def label_png(index: int) -> Response:
    lab = label.RECENT.get(index) or label.new_label(index)
    return Response(label.render_png(lab), media_type="image/png")


@app.post("/api/judge")
async def judge(request: Request) -> dict:
    """You sort mode: grade a person's choice against the hidden key."""
    body = await request.json()
    p = _parcel(body["id"])
    action = body.get("action")
    if action not in ("ship", "retape", "hold", "return", "missed"):
        raise HTTPException(400, "action must be ship, retape, hold, return or missed")
    if action == "missed":
        # the belt does not wait: an undecided parcel goes through unchecked
        damaged = p["truth"]["action"] in ("hold", "return")
        return {"id": p["id"], "action": "missed", "outcome": "near_miss" if damaged else "missed",
                "truth": p["truth"]["action"]}
    return {"id": p["id"], "action": action, "outcome": engine.grade(p["truth"], action),
            "truth": p["truth"]["action"]}


@app.post("/api/run")
async def start(request: Request) -> dict:
    body = await request.json()
    mode = body.get("mode", "workflow")
    limit = body.get("limit")
    pace = body.get("pace")
    seed = body.get("seed") or False
    walk = bool(body.get("walk"))
    if mode not in ("workflow", "h2h"):
        raise HTTPException(400, "mode must be 'workflow' or 'h2h'")
    if seed not in (False, True, "only"):
        raise HTTPException(400, "seed must be true, false or 'only'")
    if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 30):
        raise HTTPException(400, "limit must be a whole number from 1 to 30")
    if pace is not None and (not isinstance(pace, (int, float)) or isinstance(pace, bool) or not 0 <= pace <= 5):
        raise HTTPException(400, "pace must be a number of seconds from 0 to 5")
    try:
        chosen = sets.resolve(body.get("set"), body.get("ids"))   # ids win over set; both win over limit
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if RUN["task"] and not RUN["task"].done():
        RUN["task"].cancel()
        await asyncio.sleep(0.1)
    BUS.history.clear()
    STREAM.history.clear()

    async def go() -> None:
        try:
            await run_workflow(mode, BUS.emit, limit, pace, stream=STREAM.emit, seed=seed, parcels=chosen,
                               walk=walk and mode == "workflow")
        except asyncio.CancelledError:
            BUS.emit({"type": "run_stopped", "t": 0})
            stream("run_stopped")
        except Exception as exc:  # noqa: BLE001
            err = f"{type(exc).__name__}: {str(exc)[:300]}"
            BUS.emit({"type": "run_error", "t": 0, "error": err})
            stream("run_error", error=err)

    RUN.update(task=asyncio.create_task(go()), mode=mode)
    return {"started": mode, "parcels": [p["id"] for p in chosen] if chosen is not None else None,
            "set": body.get("set") if body.get("ids") is None else None, "walk": walk and mode == "workflow"}


@app.post("/api/stop")
async def stop() -> dict:
    if RUN["task"] and not RUN["task"].done():
        RUN["task"].cancel()
    return {"stopped": True}


def _sse(bus: Bus, request: Request) -> StreamingResponse:
    q: asyncio.Queue = asyncio.Queue()
    bus.queues.add(q)

    async def stream():
        try:
            yield "retry: 1000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            bus.queues.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/events")
async def events(request: Request) -> StreamingResponse:
    """The original page's event stream (belt/static)."""
    return _sse(BUS, request)


@app.get("/api/stream")
async def contract_stream(request: Request) -> StreamingResponse:
    """The API contract stream (belt/API.md): {type, ts, ...} JSON events."""
    return _sse(STREAM, request)


# ── the floor manager: thresholds, the human lane, the teacher ──────────────

@app.get("/api/safety")
def get_safety() -> dict:
    """The safety gate: per-action bars (base + effective), audit sample, drift state, rule counts,
    the routes of the last run, and the calibration result (belt/calibration.json)."""
    return floor.safety_public()


@app.post("/api/safety")
async def set_safety(request: Request) -> dict:
    """Body (any of): {ship, retape, hold, abstain, audit_rate, alpha, reset_drift: true}."""
    body = await request.json()
    try:
        if any(body.get(k) is not None for k in ("ship", "retape", "hold", "abstain")):
            th = floor.set_thresholds(ship=body.get("ship"), retape=body.get("retape"), hold=body.get("hold"),
                                      abstain=body.get("abstain"))
            stream("thresholds", **th)
        floor.set_safety_config(audit_rate=body.get("audit_rate"), alpha=body.get("alpha"))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if body.get("reset_drift"):
        d = floor.SAFETY.reset_drift()
        stream("drift", **d, reason="reset by a person", effective=floor.effective_bars(floor.thresholds(), d))
    return floor.safety_public()


@app.post("/api/you/jev")
async def you_jev(request: Request) -> dict:
    """Mode 1 summary: Jev on the same parcels the person sorted. Body {ids: [...], source: "live"|"replay"}.
    live (default): one Jev call per parcel now, in parallel; any call that fails answers from the recording
    and says so per parcel (`live: false`). replay: the recorded answers only (belt/replay.json, no request)."""
    body = await request.json()
    ids = [str(i) for i in (body.get("ids") or [])][:60]
    source = body.get("source") or ("replay" if jev.force_replay() else "live")
    if source not in ("live", "replay"):
        raise HTTPException(400, "source must be 'live' or 'replay'")
    parcels = [_parcel(i) for i in ids]
    c = jev.client() if source == "live" else None
    sem = asyncio.Semaphore(6)

    async def one(p: dict) -> dict:
        async with sem:
            try:
                out = await jev.judge_photo(c, p["id"], ROOT / p["file"], p["declared"], None, claim_ready=False,
                                            purpose="you vs jev", photo_url=f"/api/photos/{p['id']}.jpg")
            except RuntimeError as exc:
                return {"id": p["id"], "error": str(exc)[:200], "truth": p["truth"]["action"]}
        th = floor.thresholds()
        d = reflex.choose(out, claim_ready=False, handling=None, trust=th["abstain"], auto_ship=th["ship"])
        g = floor.gate_route(d["model_choice"], d["confidence"], d["damaged"], d["risk"], p["declared"],
                             engine.handling_marks(p), th)
        return {"id": p["id"], "choice": d["model_choice"], "action": d["action"], "confidence": d["confidence"],
                "probabilities": d["probabilities"], "damaged": d["damaged"], "risk": d["risk"],
                "outcome": engine.grade(p["truth"], d["model_choice"]), "truth": p["truth"]["action"],
                "lane": g["lane"], "rule": g["rule"], "live": not out.get("replay"), "ms": out.get("ms"),
                "call_id": out.get("call_id")}
    try:
        answers = await asyncio.gather(*[one(p) for p in parcels])
    finally:
        await jev.aclose(c)
    ok = [a for a in answers if "error" not in a]
    count = lambda k: sum(1 for a in ok if a["outcome"] == k)  # noqa: E731
    live_n = sum(1 for a in ok if a["live"])
    return {"source": source, "answers": answers,
            "source_label": (f"Jev {jev.MODEL}, {live_n} live call(s) now" +
                             (f", {len(ok) - live_n} from the recording (belt/replay.json)" if len(ok) - live_n else ""))
            if source == "live" else "Jev answers recorded earlier (belt/replay.json, Standard policy): no request sent",
            "summary": {"n": len(ok), "correct": count("correct"), "safe": count("safe"), "wrong": count("wrong"),
                        "near_miss": count("near_miss"),
                        "ms_avg": round(sum(a["ms"] or 0 for a in ok) / len(ok)) if ok else None,
                        "errors": len(answers) - len(ok)}}


@app.get("/api/thresholds")
def get_thresholds() -> dict:
    return floor.thresholds()


@app.post("/api/thresholds")
async def set_thresholds(request: Request) -> dict:
    """Body: {"auto": 0.9, "abstain": 0.4} (any of auto|ship, retape, hold, abstain; auto = ship).
    Effective for the next parcel."""
    body = await request.json()
    try:
        th = floor.set_thresholds(auto=body.get("auto"), abstain=body.get("abstain"), ship=body.get("ship"),
                                  retape=body.get("retape"), hold=body.get("hold"))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    stream("thresholds", **th)
    return th


@app.get("/api/human")
def human_queue() -> dict:
    return {"pending": floor.HUMAN.pending(), "decided": floor.HUMAN.decided()}


@app.post("/api/human/{parcel_id}")
async def human_decide(parcel_id: str, request: Request) -> dict:
    """Body: {"action": "ship"|"retape"|"hold"|"return"}. A person decides a held parcel."""
    body = await request.json()
    try:
        item = floor.HUMAN.decide(parcel_id, body.get("action"))
    except KeyError as exc:
        raise HTTPException(404, f"{parcel_id} is not in the human lane") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    from belt.workflow import LAST  # noqa: PLC0415
    belt = LAST["belt"]
    if item.get("kind") == "audit":
        # shadow review of a parcel Jev already decided alone: the answer is the audit label, the
        # parcel's own decision and score row stay as they were (it is already down the belt)
        rec, change = floor.SAFETY.relabel(parcel_id, item["action"])
        stream("human_decided", parcel_id=parcel_id, action=item["action"], kind="audit",
               audit_error=(rec or {}).get("error"))
        if rec:
            stream("audit", phase="relabel", **{k: rec.get(k) for k in (
                "parcel_id", "auto_action", "gemini_action", "flagged", "error", "label", "label_source")})
        if change:
            stream("drift", **change, effective=floor.effective_bars(floor.thresholds(), floor.SAFETY.drift()))
        if belt:
            stream("stats", **belt.stats())
        return {**{k: v for k, v in item.items() if k != "file"}, "outcome": None, "audit": rec}
    row = belt.score.update(parcel_id, item["action"]) if belt else None
    stream("human_decided", parcel_id=parcel_id, action=item["action"], outcome=(row or {}).get("outcome"))
    stream("decision", parcel_id=parcel_id, final_action=item["action"], decided_by="human")
    if belt:
        stream("stats", **belt.stats())
    return {**{k: v for k, v in item.items() if k != "file"}, "outcome": (row or {}).get("outcome")}


@app.post("/api/teach/run")
async def teach_run() -> dict:
    """Run the teacher agent on the human lane. Returns the proposal; nothing is applied."""
    if not floor.HUMAN.decided():
        raise HTTPException(400, "no human decisions yet: decide some held parcels first")
    if TEACH["task"] and not TEACH["task"].done():
        raise HTTPException(409, "the teacher is already running")
    TEACH["task"] = asyncio.create_task(run_teach(stream=STREAM.emit))
    try:
        prop = await TEACH["task"]
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    return _proposal_public(prop)


def _proposal_public(prop: dict) -> dict:
    return {k: prop.get(k) for k in ("proposal_id", "diff", "diff_text", "rationale", "parcel_ids", "status",
                                     "live", "call_id", "base_version", "rule_text", "evidence",
                                     "applied_version", "warnings")}


@app.get("/api/teach")
def teach_list() -> dict:
    """Every proposal of this server's life, oldest first (the page shows the last one after a reload),
    plus the last re-judge result per proposal, so a reload does not need a second live re-judge."""
    return {"proposals": [_proposal_public(p) for p in floor.PROPOSALS.values()],
            "rejudge": {pid: p["rejudge"] for pid, p in floor.PROPOSALS.items() if p.get("rejudge")}}


@app.post("/api/teach/{proposal_id}/rejudge")
async def teach_rejudge(proposal_id: str) -> dict:
    """v1 vs v2 on the same parcels: Jev on each cited parcel under the proposal's base policy and under
    its new policy, in parallel. No second full run. A failed call gives that row before/after = null.
    Each side also carries the lane the real safety gate (floor.gate_route) gives that answer now, so the
    page can say whether a better answer actually leaves the desk (`leaves_desk`, `still_person_reason`)."""
    prop = floor.PROPOSALS.get(proposal_id)
    if prop is None:
        raise HTTPException(404, "no such proposal")
    if prop["status"] == "no_change":
        raise HTTPException(409, "this proposal changes nothing, so there is nothing to re-judge")
    base = prop.get("base_options") or policy.DEFAULT
    after_opts = prop["options"]
    after_v = prop.get("applied_version") or prop["base_version"] + 1
    th, drift = floor.thresholds(), floor.SAFETY.drift()
    c = jev.client()
    sem = asyncio.Semaphore(6)

    async def judge(p: dict, options: dict, tag: str) -> dict | None:
        async with sem:
            try:
                out = await jev.judge_photo(c, p["id"], ROOT / p["file"], p["declared"], None, claim_ready=False,
                                            options=options, purpose=f"re-judge {tag}",
                                            photo_url=f"/api/photos/{p['id']}.jpg")
            except RuntimeError:
                return None
        d = reflex.choose(out, claim_ready=False, handling=None)
        calls.annotate(out.get("call_id"), decision=d["model_choice"], why=f"re-judge {tag}",
                       confidence=d["confidence"])
        # the lane the belt's own safety gate would give this answer now (same function, same bars)
        g = floor.gate_route(d["model_choice"], d["confidence"], d["damaged"], d["risk"], p["declared"],
                             engine.handling_marks(p), th, drift)
        return {"action": d["model_choice"], "confidence": round(float(d["confidence"]), 3),
                "damaged": d["damaged"], "risk": d["risk"], "lane": g["lane"], "rule": g["rule"],
                "checks": [ch["rule"] for ch in g["checks"] if ch["fired"]],
                "live": not out.get("replay"), "call_id": out.get("call_id")}

    async def row(ev: dict) -> dict:
        p = engine.find_parcel(ev["parcel_id"])
        if p is None:
            before = after = None
        else:
            before, after = await asyncio.gather(judge(p, base, f"v{prop['base_version']}"),
                                                 judge(p, after_opts, f"v{after_v}"))
        person = ev.get("person_action")
        return {"parcel_id": ev["parcel_id"], "photo_url": ev.get("photo_url"), "declared": ev.get("declared"),
                "person_action": person, "before": before, "after": after,
                "live": bool(before and after and before["live"] and after["live"]),
                "match_before": bool(before and before["action"] == person),
                "match_after": bool(after and after["action"] == person),
                "leaves_desk": bool(after and after["lane"] != "human"),
                "still_person_reason": floor.still_person_reason(after, person, th, drift)}
    try:
        rows = await asyncio.gather(*[row(ev) for ev in prop.get("evidence") or []])
    finally:
        await jev.aclose(c)
    result = {"proposal_id": proposal_id, "version_before": prop["base_version"],
              "version_after": after_v, "rows": rows,
              "matches_before": sum(r["match_before"] for r in rows),
              "matches_after": sum(r["match_after"] for r in rows),
              "left_desk_before": sum(bool(r["before"] and r["before"]["lane"] != "human") for r in rows),
              "left_desk_after": sum(r["leaves_desk"] for r in rows),
              "desk_bar": floor.effective_bars(th, drift)["abstain"], "k": len(rows)}
    prop["rejudge"] = result                    # kept for GET /api/teach (a reload shows it again)
    stream("teach_rejudge", **result)
    return result


@app.post("/api/teach/{proposal_id}/approve")
async def teach_approve(proposal_id: str) -> dict:
    """A person approves the teacher's proposal: the policy version bumps; the next Jev calls use it."""
    try:
        state = floor.approve(proposal_id)
    except KeyError as exc:
        raise HTTPException(404, "no such proposal") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    BUS.emit({"type": "policy", **state})
    stream("teach_approved", proposal_id=proposal_id, version=state["version"])
    stream("policy_version", version=state["version"], policy=_policy_brief(state))
    return {"proposal_id": proposal_id, "status": "approved", "version": state["version"], "policy": state}


# ── the built front end (web/dist), served last so it never shadows /api ────

@app.get("/{path:path}")
def built_file(path: str):
    """Files of the built front end (assets, icons). SPA routes fall back to its index.html."""
    if path.startswith("api/") or not DIST.is_dir():
        raise HTTPException(404, "not found")
    target = (DIST / path).resolve()
    if target.is_file() and target.is_relative_to(DIST.resolve()):
        return FileResponse(target)
    if (DIST / "index.html").is_file() and "." not in Path(path).name:
        return HTMLResponse((DIST / "index.html").read_text())
    raise HTTPException(404, "not found")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="The belt page")
    ap.add_argument("--host", default=os.environ.get("BELT_HOST", "127.0.0.1"),
                    help="bind address (default 127.0.0.1, or BELT_HOST)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("BELT_PORT", "8095")),
                    help="port (default 8095, or BELT_PORT)")
    return ap.parse_args(argv)


def main() -> None:
    import uvicorn  # noqa: PLC0415
    a = parse_args()
    print(f"belt page on http://{a.host}:{a.port}/")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
