"""Offline tests for the floor manager: lanes, the Gemini skip, the tool guard, the human lane, the teacher.

No keys, no network: Jev is faked at judge_photo, Gemini runs in forced replay (BELT_REPLAY=1)."""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from belt import engine, floor, policy, reflex  # noqa: E402


@pytest.fixture(autouse=True)
def clean_floor():
    cfg = dict(floor.SAFETY_CONFIG)
    floor.set_safety_config(audit_rate=0)          # audit sampling has its own tests (test_safety.py)
    floor.reset_thresholds()
    floor.HUMAN.reset()
    floor.PROPOSALS.clear()
    policy.reset()
    yield
    floor.SAFETY_CONFIG.update(cfg)
    floor.reset_thresholds()
    floor.HUMAN.reset()
    floor.PROPOSALS.clear()
    policy.reset()


# ── 1. routing bands ────────────────────────────────────────────────────────

@pytest.mark.parametrize("conf,lane", [(0.97, "auto"), (0.80, "auto"), (0.7999, "gemini"), (0.60, "gemini"),
                                       (0.40, "gemini"), (0.3999, "human"), (0.0, "human")])
def test_legacy_single_threshold_bands(conf, lane):
    """lane_for() is the OLD gate (one bar, 0.80 / 0.40), kept for the comparison."""
    assert floor.lane_for(conf)[0] == lane


def test_thresholds_move_the_bars_and_validate():
    route = lambda c: floor.gate_route("ship", c, 0.05, 0.1, "Paperback books", "")["lane"]  # noqa: E731
    assert route(0.7) == "gemini"
    th = floor.set_thresholds(auto=0.65)                      # auto = the ship bar
    assert th["auto"] == th["ship"] == 0.65 and th["abstain"] == 0.40
    assert route(0.7) == "auto"
    floor.set_thresholds(abstain=0.5, hold=0.5, retape=0.6)
    assert route(0.49) == "human" and route(0.66) == "auto"
    for bad in ({"auto": 1.5}, {"abstain": -0.1}, {"auto": "x"}, {"auto": 0.3, "abstain": 0.5},
                {"hold": 0.2}):
        with pytest.raises(ValueError):
            floor.set_thresholds(**bad)
    assert floor.thresholds() == {"auto": 0.65, "abstain": 0.5, "ship": 0.65, "retape": 0.6, "hold": 0.5}


def test_choose_follows_runtime_thresholds():
    a = {"action": {"choice": "ship", "confidence": 0.7, "probabilities": {"ship": 0.8}},
         "damaged": {"noul": 0.1}, "risk": {"score": 0.2}}
    assert reflex.choose(a, False)["action"] == "spot_check"
    assert reflex.choose(a, False, auto_ship=0.65)["action"] == "ship"


def test_after_second_look_rules():
    assert floor.after_second_look({"action": "retape", "needs_human": False}, 0.1) == ("gemini", "second_look: retape")
    assert floor.after_second_look({"action": "hold", "needs_human": True}, 0.1)[0] == "human"
    assert floor.after_second_look({"action": "ship", "needs_human": False}, 0.7)[0] == "human"   # disagree
    assert floor.after_second_look({"action": "teleport"}, 0.1)[0] == "human"


# ── 3. the tool guard ───────────────────────────────────────────────────────

DAMAGED = {"choice": "hold", "confidence": 0.95, "damaged": 0.9}
INTACT = {"choice": "ship", "confidence": 0.9, "damaged": 0.05}
CLAIM = {"parcel_id": "P-0105", "tracking": "DX 1234 5678 9012", "consignee_zip": "11201", "claim_note": "x"}
REFUND = {"parcel_id": "P-0105", "tracking": "DX 1234 5678 9012", "amount_usd": 40, "reason": "broken"}


def test_guard_allows_claim_on_damaged_readable():
    r = floor.guard_tool("file_claim", CLAIM, DAMAGED, already_filed=False)
    assert r["allowed"] and r["rule"] == "jev_damaged_and_packet_readable"
    assert r["evidence"]["jev_damaged"] == 0.9 and r["evidence"]["tracking"] == CLAIM["tracking"]
    assert floor.guard_tool("issue_refund", REFUND, DAMAGED, already_filed=False)["allowed"]


@pytest.mark.parametrize("tool,args,verdict,filed,rule", [
    ("file_claim", {**CLAIM, "tracking": "UNREADABLE"}, DAMAGED, False, "packet_unreadable"),
    ("file_claim", {**CLAIM, "consignee_zip": "UNREADABLE"}, DAMAGED, False, "packet_unreadable"),
    ("issue_refund", REFUND, INTACT, False, "jev_says_intact"),
    ("file_claim", CLAIM, INTACT, False, "jev_sees_no_damage"),
    ("file_claim", CLAIM, DAMAGED, True, "duplicate_claim_for_parcel"),
    ("file_claim", CLAIM, None, False, "no_jev_verdict_for_parcel"),
    ("issue_refund", {**REFUND, "amount_usd": 900}, DAMAGED, False, "refund_over_limit_needs_human"),
    ("delete_db", CLAIM, DAMAGED, False, "unknown_tool"),
])
def test_guard_blocks(tool, args, verdict, filed, rule):
    r = floor.guard_tool(tool, args, verdict, already_filed=filed)
    assert not r["allowed"] and r["rule"] == rule


def test_guard_intact_rule_uses_runtime_auto_threshold():
    unsure_intact = {"choice": "ship", "confidence": 0.7, "damaged": 0.7}
    assert floor.guard_tool("issue_refund", REFUND, unsure_intact, False)["allowed"]
    floor.set_thresholds(auto=0.6)
    assert floor.guard_tool("issue_refund", REFUND, unsure_intact, False)["rule"] == "jev_says_intact"


# ── 2. the skip callback + the whole workflow, offline ─────────────────────

FAKE = {  # parcel -> (choice, confidence, damaged)
    "P-0101": ("ship", 0.92, 0.05),     # auto
    "P-0102": ("ship", 0.60, 0.10),     # gemini (defer band)
    "P-0103": ("hold", 0.30, 0.85),     # human (abstain) + Jev sees damage -> label read #1
    "P-0104": ("hold", 0.95, 0.90),     # auto + damage -> label read #2 (smudged) -> blocked, re-scan #3
    "P-0105": ("ship", 0.88, 0.04),     # auto
}


def _fake_answers(pid):
    choice, conf, damaged = FAKE[pid]
    probs = {k: 0.05 for k in ("ship", "retape", "hold", "return")}
    probs[choice] = 0.85
    return {"action": {"choice": choice, "confidence": conf, "probabilities": probs},
            "damaged": {"noul": damaged}, "risk": {"score": 1.6 if damaged > 0.5 else 0.1},
            "model": "jev-1.14.0", "input_tokens": 1800, "output_tokens": 90, "ms": 100, "replay": False}


@pytest.fixture
def offline(monkeypatch):
    from belt import calls, jev
    monkeypatch.setenv("BELT_REPLAY", "1")                   # Gemini answers from code, no network
    monkeypatch.setenv("BELT_REPLAY_GEMINI_SECONDS", "0")
    monkeypatch.delenv("BELT_RECORD", raising=False)
    monkeypatch.setattr(jev, "replay_get", lambda kind, key: None)   # build every replay from the key

    async def judge_photo(client, key, photo, declared, handling, claim_ready, **kw):
        out = _fake_answers(key)
        rec = calls.start("jev", model="jev-1.14.0", purpose="belt", parcel=key, live=True)
        calls.finish(rec, ms=100, input_tokens=1800, output_tokens=90)
        return {**out, "call_id": rec["id"]}
    monkeypatch.setattr(jev, "judge_photo", judge_photo)
    monkeypatch.setattr(engine, "MAX_TICKS", 30)


def _run(limit=5):
    from belt.run import run_workflow
    events = []
    asyncio.run(run_workflow("workflow", lambda e: None, limit, 0, stream=events.append))
    return events


def test_workflow_lanes_skip_guard_end_to_end(offline):
    ev = _run()
    kinds = [e["type"] for e in ev if e["type"] != "adk_node"]
    assert kinds[0] == "run_start" and kinds[-1] == "run_end"
    assert all("ts" in e for e in ev)
    routes = {e["parcel_id"]: e["lane"] for e in ev if e["type"] == "route" and "escalated_from" not in e}
    # P-0105 (Ceramic mugs, FRAGILE sticker, ship 0.88): the old gate auto-shipped it; the safety gate
    # sends a fragile ship to a second look
    assert routes == {"P-0101": "auto", "P-0102": "gemini", "P-0103": "human", "P-0104": "auto", "P-0105": "gemini"}
    rules = {e["parcel_id"]: e["rule"] for e in ev if e["type"] == "route" and "escalated_from" not in e}
    assert rules == {"P-0101": "auto_ship", "P-0102": "below_ship_bar", "P-0103": "abstain_low_confidence",
                     "P-0104": "auto_hold", "P-0105": "fragile_no_auto_ship"}
    legacy = {e["parcel_id"]: e["legacy_lane"] for e in ev if e["type"] == "route" and "escalated_from" not in e}
    assert legacy["P-0105"] == "auto"
    # Gemini skipped for the confident ones and the abstained one, by before_model_callback
    skipped = {e["parcel_id"]: e for e in ev if e["type"] == "gemini_skipped"}
    assert set(skipped) == {"P-0101", "P-0103", "P-0104"}
    assert skipped["P-0101"]["by"] == "before_model_callback" and skipped["P-0101"]["saved_ms_est"] > 0
    second = [e for e in ev if e["type"] == "llm_start" and e["agent"] == "second_look"]
    assert [e["parcel_id"] for e in second] == ["P-0102", "P-0105"]      # Gemini only on escalations
    # the guard: label #2 is smudged -> UNREADABLE -> blocked, re-scan -> allowed
    guards = [e for e in ev if e["type"] == "guard_verdict"]
    proposed = [e for e in ev if e["type"] == "tool_proposed"]
    assert len(proposed) == len(guards) == 3
    assert [g["allowed"] for g in guards] == [True, False, True]
    assert guards[1]["rule"] == "packet_unreadable" and guards[1]["parcel_id"] == "P-0104"
    assert all(g["call_id"] for g in guards)
    dec = [(e["parcel_id"], e["decided_by"], e["final_action"]) for e in ev if e["type"] == "decision"]
    assert ("P-0101", "jev", "ship") in dec and ("P-0102", "gemini", "ship") in dec
    assert [d[2] for d in dec if d[0] == "P-0103"] == ["hold", "file_claim"]     # held, then claim filed
    assert [d[2] for d in dec if d[0] == "P-0104"] == ["hold", "file_claim"]
    assert [e["parcel_id"] for e in ev if e["type"] == "human_queue"] == ["P-0103"]
    last = [e for e in ev if e["type"] == "run_end"][-1]
    end = last["scorecard"]
    assert end["lanes"] == {"auto": 2, "gemini": 2, "human": 1} and end["gemini_skipped"] == 3
    assert end["blocked_tools"] == 1 and end["allowed_tools"] == 2 and end["human_pending"] == 1
    assert last["report"]["headline"].endswith("(replay, not Gemini)")
    nodes = {e["node"] for e in ev if e["type"] == "adk_node"}
    assert {"tick", "gate", "second_look", "claims_clerk", "shift_lead", "read_label"} <= nodes
    for e in ev:
        if e["type"] == "llm_end":
            assert e["live"] is False and e["cost"] == 0
    # every Gemini call carries its job; decision calls (2nd look) are counted apart from clerk/report work
    jobs = {e["agent"]: (e["job"], e["job_label"]) for e in ev if e["type"] == "llm_start"}
    assert jobs["second_look"] == ("decision", "2nd look (decision on unsure parcels)")
    assert jobs["claims_clerk"][0] == "clerk" and jobs["shift_lead"][0] == "report"
    assert all(e.get("job") for e in ev if e["type"] == "llm_end")
    assert end["gemini_decision_calls"] == 2                      # P-0102 and P-0105 got a second look
    assert end["gemini_work_calls"] == end["gemini_calls"] - 2    # label reads + the report
    assert end["safety"]["rules"]["fragile_no_auto_ship"] == 1 and end["safety"]["audit"]["n"] == 0
    assert set(end["gemini_jobs"]) == {"decision", "clerk", "report"}


def test_skip_callback_directly(offline):
    """before_model_callback returns an LlmResponse (skip) for auto/human lanes, None for the defer band."""
    from google.genai import types

    from belt import workflow as wf
    belt = wf.Belt(lambda e: None, "workflow", limit=5, make_client=False, stream=(got := []).append)
    wf.BELTS["test-session"] = belt
    try:
        for pid in ("P-0101", "P-0102"):
            belt.verdicts[pid] = {"answers": _fake_answers(pid)}
        req = lambda pid: SimpleNamespace(contents=[types.Content(role="user", parts=[types.Part(text=f"PARCEL {pid}")])])  # noqa: E731
        belt.verdicts["P-0101"]["gate"] = floor.gate_route("ship", 0.92, 0.05, 0.1, "Paperback books", "")
        skip = wf._second_look_gate(belt, req("P-0101"))
        assert skip is not None and skip.custom_metadata == {"belt_skipped": True}
        assert json.loads(skip.content.parts[0].text)["action"] == "ship"
        belt.verdicts["P-0101"]["gate"] = floor.gate_route("ship", 0.92, 0.05, 0.1, "Paperback books", "")
        belt.verdicts["P-0102"]["gate"] = floor.gate_route("ship", 0.60, 0.1, 0.1, "Phone case", "")
        assert wf._second_look_gate(belt, req("P-0102")) is None
        floor.set_thresholds(auto=0.55)                         # move the slider: the next gate call auto-ships
        belt.verdicts["P-0102"]["gate"] = floor.gate_route("ship", 0.60, 0.1, 0.1, "Phone case", "")
        belt.auditing.add("P-0102")                             # ... unless it is in the audit sample
        assert wf._second_look_gate(belt, req("P-0102")) is None
        belt.auditing.discard("P-0102")
        assert wf._second_look_gate(belt, req("P-0102")) is not None
        assert [e["parcel_id"] for e in got if e["type"] == "gemini_skipped"] == ["P-0101", "P-0102"]
        assert belt.skipped == 2
    finally:
        wf.BELTS.pop("test-session", None)


def test_skip_estimate_prefers_measured_calls():
    assert floor.skip_estimate([])["basis"].startswith("prior")
    est = floor.skip_estimate([{"agent": "second_look", "ms": 3000, "cost": 0.002, "live": True},
                               {"agent": "second_look", "ms": 5000, "cost": 0.004, "live": True},
                               {"agent": "claims_clerk", "ms": 9000, "cost": 0.01, "live": True},
                               {"agent": "second_look", "ms": 100, "cost": 0, "live": False}])
    assert est["saved_ms_est"] == 4000 and est["saved_cost_est"] == pytest.approx(0.003)
    assert est["basis"].startswith("estimate") and est["n"] == 2
    # like with like: a label read is a different job, so it never stands in for a second look
    clerk_only = floor.skip_estimate([{"agent": "claims_clerk", "ms": 9000, "cost": 0.01, "live": True}])
    assert clerk_only["basis"].startswith("prior") and clerk_only["n"] == 0


# ── 4 + 5. the human lane and the teacher, over the API ─────────────────────

@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    from belt import server
    monkeypatch.setenv("BELT_REPLAY", "1")
    monkeypatch.setenv("BELT_REPLAY_GEMINI_SECONDS", "0")
    monkeypatch.delenv("BELT_RECORD", raising=False)
    with TestClient(server.app) as c:
        yield c


def _queue(pid="P-0112", declared="Brass pipe fittings, 100"):
    floor.HUMAN.add(pid, "confidence 0.32 < abstain 0.40", declared=declared, file=f"photos/real/{pid}.jpg",
                    jev={"choice": "hold", "confidence": 0.32, "probabilities": {"hold": 0.55}, "damaged": 0.82})


def test_human_decide_endpoint(client):
    _queue()
    assert client.post("/api/human/P-0112", json={"action": "teleport"}).status_code == 400
    assert client.post("/api/human/P-9999", json={"action": "hold"}).status_code == 404
    r = client.post("/api/human/P-0112", json={"action": "return"})
    assert r.status_code == 200 and r.json()["action"] == "return" and r.json()["status"] == "decided"
    assert client.post("/api/human/P-0112", json={"action": "hold"}).status_code == 400    # decided once
    q = client.get("/api/human").json()
    assert q["pending"] == [] and q["decided"][0]["action"] == "return"


def test_thresholds_endpoint(client):
    assert client.get("/api/thresholds").json() == {"auto": floor.DEFAULTS["ship"], **floor.DEFAULTS}
    assert client.post("/api/thresholds", json={"auto": 0.3, "abstain": 0.5}).status_code == 400
    r = client.post("/api/thresholds", json={"auto": 0.7}).json()
    assert r["auto"] == r["ship"] == 0.7 and r["abstain"] == floor.DEFAULTS["abstain"]


def test_teach_run_proposes_and_approve_applies(client):
    assert client.post("/api/teach/run").status_code == 400            # nothing decided yet
    _queue()
    client.post("/api/human/P-0112", json={"action": "return"})
    r = client.post("/api/teach/run")
    assert r.status_code == 200
    prop = r.json()
    assert prop["status"] == "proposed" and prop["parcel_ids"] == ["P-0112"] and not prop["live"]
    assert prop["diff"][0]["option"] == "return" and prop["diff"][0]["before"] == reflex.RESPONSES["return"]
    assert "Brass pipe fittings" in prop["diff"][0]["after"] and "+" in prop["diff_text"]
    assert policy.version() == 1                                       # never auto-applied
    assert client.post("/api/teach/T999/approve").status_code == 404
    a = client.post(f"/api/teach/{prop['proposal_id']}/approve")
    assert a.status_code == 200 and a.json()["version"] == 2
    assert policy.current_options()["return"] == prop["diff"][0]["after"]
    q = reflex.parcel_questions(False, policy=policy.current_options())   # what the next Jev call asks
    assert "Brass pipe fittings" in q["action"].criteria["return"]
    assert client.post(f"/api/teach/{prop['proposal_id']}/approve").status_code == 409   # only once


def test_teach_proposal_validation():
    with pytest.raises(ValueError):
        floor.new_proposal([{"option": "teleport", "new_text": "x"}], "r", [], live=False)
    same = floor.new_proposal([{"option": "ship", "new_text": policy.DEFAULT["ship"]}], "r", [], live=False)
    assert same["status"] == "no_change" and same["diff"] == [] and same["rule_text"] == ""
    with pytest.raises(ValueError):
        floor.approve(same["proposal_id"])                    # nothing to approve
    with pytest.raises(ValueError):
        floor.new_proposal([{"option": "ship", "new_text": "x" * 500}], "r", [], live=False)


def test_contract_photo_and_inspect_routes(client):
    r = client.get("/api/photos/P-0101.jpg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert client.get("/api/photos/../x.jpg").status_code == 404
    assert client.get("/api/inspect/nope").status_code == 404


def test_serves_built_frontend_when_present(client, tmp_path, monkeypatch):
    from belt import server
    monkeypatch.setattr(server, "DIST", tmp_path / "missing")
    assert "<html" in client.get("/").text.lower()                  # fallback: belt/static
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><html><body>NEW FRONT END</body></html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    monkeypatch.setattr(server, "DIST", dist)
    assert "NEW FRONT END" in client.get("/").text
    assert client.get("/assets/app.js").text == "console.log(1)"
    assert "NEW FRONT END" in client.get("/belt/live").text          # SPA route
    assert "root:" not in client.get("/assets/../../etc/passwd").text     # never leaves web/dist
    assert client.get("/api/nope").status_code == 404
    assert "belt.js" in client.get("/legacy").text                   # the original page stays reachable
