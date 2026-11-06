"""Mode 2 (Jev vs Gemini, head-to-head), the Gemini model config, and the removed webcam mode.

Offline: Jev is faked at judge_photo, gemini_reflex answers from a fake recording (BELT_REPLAY=1)."""
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from belt import engine, floor, h2h, policy  # noqa: E402

# ── the scoreboard (pure) ───────────────────────────────────────────────────


def _side(action, p, ms, outcome, cost=0.001, tin=1000, tout=10, live=True):
    return {"action": action, "p_chosen": p, "ms": ms, "outcome": outcome, "cost": cost,
            "tokens_in": tin, "tokens_out": tout, "live": live}


def test_scoreboard_numbers():
    rows = [
        {"parcel_id": "A", "truth": "ship", "jev": _side("ship", 0.97, 100, "correct"),
         "gemini": _side("ship", 0.95, 2000, "correct", cost=0.002)},
        {"parcel_id": "B", "truth": "hold", "jev": _side("hold", 0.70, 120, "correct"),
         "gemini": _side("ship", 0.90, 3000, "near_miss", cost=0.002)},
        {"parcel_id": "C", "truth": "retape", "jev": _side("ship", 0.55, 110, "wrong"),
         "gemini": _side("retape", 0.85, 4000, "correct", cost=0.002)},
        {"parcel_id": "D", "truth": "ship", "jev": _side("ship", 0.99, 90, "correct"),
         "gemini": {"action": None, "error": "boom", "cost": 0, "live": False, "outcome": None}},
    ]
    b = h2h.scoreboard(rows)
    assert b["parcels"] == 4 and b["both_answered"] == 3 and b["agree"] == 1
    assert b["agreement_rate"] == pytest.approx(1 / 3, abs=1e-3)
    j, g = b["jev"], b["gemini"]
    assert j["correct"] == 3 and j["accuracy"] == 0.75 and j["near_miss"] == 0 and j["wrong"] == 1
    assert g["correct"] == 2 and g["accuracy"] == 0.5 and g["near_miss"] == 1 and g["errors"] == 1
    assert j["ms_mean"] == 105 and j["ms_p95"] == 120               # nearest rank of 4 values = the max
    assert g["ms_mean"] == 3000 and g["ms_p95"] == 4000
    assert j["cost_per_1k"] == pytest.approx(1.0) and g["cost_per_1k"] == pytest.approx(1.5)
    assert b["gemini_wait_s"] == 3.0 and b["jev_wait_s"] == 0.105
    # calibration bins: [0,.6) [.6,.8) [.8,.95) [.95,1]
    jb = {(x["lo"], x["hi"]): x for x in b["calibration"]["jev"]}
    assert jb[(0.0, 0.6)]["n"] == 1 and jb[(0.0, 0.6)]["accuracy"] == 0.0
    assert jb[(0.95, 1.0)]["n"] == 2 and jb[(0.95, 1.0)]["accuracy"] == 1.0
    gb = {(x["lo"], x["hi"]): x for x in b["calibration"]["gemini"]}
    assert gb[(0.8, 0.95)]["n"] == 2 and gb[(0.8, 0.95)]["accuracy"] == 0.5
    assert gb[(0.95, 1.0)]["n"] == 1                                   # 0.95 falls in the top bin
    assert sum(x["n"] for x in b["calibration"]["gemini"]) == 3        # the error is not binned
    assert "stated by the LLM" in b["confidence_kind"]["gemini"]
    assert "calibrated" in b["confidence_kind"]["jev"]
    assert h2h.scoreboard([])["agreement_rate"] is None


def test_p95_nearest_rank():
    assert h2h.p95([]) is None
    assert h2h.p95(list(range(1, 21))) == 19
    assert h2h.p95([5]) == 5


# ── an offline head-to-head run through the ADK Workflow ───────────────────

FAKE_JEV = {"P-0101": "ship", "P-0102": "hold", "P-0103": "retape"}
FAKE_GEM = {"P-0101": "ship", "P-0102": "ship", "P-0103": "retape"}
SEEN: dict = {}


@pytest.fixture
def offline_h2h(monkeypatch):
    from belt import calls, jev
    monkeypatch.setenv("BELT_REPLAY", "1")
    monkeypatch.setenv("BELT_REPLAY_GEMINI_SECONDS", "0.15")
    monkeypatch.delenv("BELT_RECORD", raising=False)
    policy.reset()
    SEEN.clear()

    def replay_get(kind, key):
        if kind == "gemini_reflex" and key in FAKE_GEM:
            a = FAKE_GEM[key]
            probs = {k: 0.02 for k in h2h.ACTIONS}
            probs[a] = 0.94
            return {"action": a, "probabilities": probs, "confidence": 0.9, "reason": "fake recording"}
        if kind == "gemini_reflex_usage" and key in FAKE_GEM:
            return {"tokens_in": 1500, "tokens_out": 40, "thought_tokens": 0, "ms": 2500}
        return None
    monkeypatch.setattr(jev, "replay_get", replay_get)

    async def judge_photo(client, key, photo, declared, handling, claim_ready, **kw):
        SEEN.setdefault(key, {})["jev_kw"] = kw
        SEEN[key]["jev_start"] = time.time()
        await asyncio.sleep(0.05)
        choice = FAKE_JEV[key]
        probs = {k: 0.05 for k in h2h.ACTIONS}
        probs[choice] = 0.85
        rec = calls.start("jev", model="jev-1.14.0", purpose="head-to-head", parcel=key, live=True)
        calls.finish(rec, ms=50, input_tokens=1200, output_tokens=20)
        return {"action": {"choice": choice, "confidence": 0.78, "probabilities": probs}, "model": "jev-1.14.0",
                "input_tokens": 1200, "output_tokens": 20, "ms": 50, "replay": False, "call_id": rec["id"]}
    monkeypatch.setattr(jev, "judge_photo", judge_photo)
    yield
    policy.reset()


def _run_h2h(limit=3):
    from belt.run import run_workflow
    events = []
    asyncio.run(run_workflow("h2h", lambda e: None, limit, 0, stream=events.append))
    return events


def test_h2h_event_shapes_and_fairness(offline_h2h):
    ev = _run_h2h()
    kinds = [e["type"] for e in ev if e["type"] != "adk_node"]
    assert kinds[0] == "run_start" and kinds[-1] == "run_end"
    start = ev[[e["type"] for e in ev].index("run_start")]
    assert start["mode"] == "h2h" and start["gemini_model"] == h2h.GEMINI_MODEL and start["total"] == 3
    assert start["prices"]["gemini_in_per_m"] == floor.GEMINI_PRICE_IN
    # no lanes, no thresholds, no skips, no claims in this mode
    assert not {"route", "gemini_skipped", "tool_proposed", "decision", "human_queue"} & set(kinds)
    answers = [e for e in ev if e["type"] == "h2h_answer"]
    assert sorted((e["parcel_id"], e["side"]) for e in answers) == sorted(
        (p, s) for p in FAKE_JEV for s in ("jev", "gemini"))
    for e in answers:
        for k in ("action", "probabilities", "p_chosen", "ms", "tokens_in", "tokens_out", "cost", "live", "outcome"):
            assert k in e, (e["side"], k)
    gem = [e for e in answers if e["side"] == "gemini"]
    assert all(set(e["probabilities"]) == set(h2h.ACTIONS) and "reason" in e and "confidence" in e for e in gem)
    results = {e["parcel_id"]: e for e in ev if e["type"] == "h2h_result"}
    assert list(results) == ["P-0101", "P-0102", "P-0103"]
    r = results["P-0102"]
    assert r["truth"] == engine.parcels()[1]["truth"]["action"]
    assert r["jev"]["action"] == "hold" and r["gemini"]["action"] == "ship" and r["agree"] is False
    assert results["P-0101"]["agree"] is True
    for row in results.values():
        assert row["jev"]["outcome"] == engine.grade({"action": row["truth"]}, row["jev"]["action"])
        assert row["gemini"]["outcome"] == engine.grade({"action": row["truth"]}, row["gemini"]["action"])
    stats = [e for e in ev if e["type"] == "h2h_stats"]
    assert len(stats) == 3 and stats[-1]["parcels"] == 3 and stats[-1]["agree"] == 2
    end = ev[-1] if ev[-1]["type"] == "run_end" else [e for e in ev if e["type"] == "run_end"][-1]
    assert end["scorecard"]["parcels"] == 3 and end["report"] is None
    # Gemini ran as a real ADK LlmAgent, labelled as a decision call
    starts = [e for e in ev if e["type"] == "llm_start"]
    assert [e["agent"] for e in starts] == ["gemini_reflex"] * 3
    assert all(e["job"] == "decision" for e in starts)
    nodes = {e["node"] for e in ev if e["type"] == "adk_node"}
    assert {"h2h_enter", "h2h_tick", "gemini_reflex", "h2h_finish"} <= nodes
    # same question: Jev was asked the action question only, with the same option texts Gemini saw
    for pid in FAKE_JEV:
        kw = SEEN[pid]["jev_kw"]
        assert kw["action_only"] is True and kw["options"] == policy.current_options()
    # concurrency: Gemini's call started before Jev's answer for the same parcel came back
    for pid in FAKE_JEV:
        g_start = next(e["ts"] for e in starts if e["parcel_id"] == pid)
        j_done = next(e["ts"] for e in answers if e["parcel_id"] == pid and e["side"] == "jev")
        assert g_start <= j_done + 0.01
    # replayed Gemini answers report the recorded latency/tokens, flagged not live
    assert all(e["live"] is False and e["ms"] == 2500 and e["tokens_in"] == 1500 for e in gem)


def test_question_text_matches_jev_question():
    from belt import reflex
    opts = policy.current_options()
    text = h2h.question_text("P-0101", "Paperback books, 3", opts)
    assert reflex.ACTION_INSTRUCTIONS in text and "PARCEL P-0101" in text
    for k in h2h.ACTIONS:
        assert f"- {k}: {opts[k]}" in text
    q = reflex.action_question(opts)
    assert list(q) == ["action"]                                       # no damaged / risk / Box for Jev
    assert dict(q["action"].criteria) == {k: opts[k] for k in h2h.ACTIONS}


def test_reflex_answer_schema_is_typed():
    schema = h2h.ReflexAnswer.model_json_schema()
    assert set(schema["properties"]) == {"action", "probabilities", "confidence", "reason"}
    assert schema["properties"]["action"]["enum"] == ["ship", "retape", "hold", "return"]
    probs = schema["$defs"]["OptionProbabilities"]["properties"]
    assert set(probs) == {"ship", "retape", "hold", "return"}
    a = h2h.ReflexAnswer.model_validate_json(json.dumps(
        {"action": "hold", "probabilities": {"ship": 0.1, "retape": 0.1, "hold": 0.7, "return": 0.1},
         "confidence": 0.7, "reason": "dent"}))
    assert a.model_dump(by_alias=True)["probabilities"]["return"] == 0.1


# ── the Gemini model is one config value ────────────────────────────────────

def test_gemini_model_default_and_every_agent_uses_it():
    from belt import teach, workflow
    assert workflow.DEFAULT_GEMINI_MODEL == "gemini-3.5-flash-lite"
    agents = [workflow.second_look, workflow.claims_clerk, workflow.shift_lead, teach.teacher, h2h.gemini_reflex]
    assert {a.name for a in agents} == {"second_look", "claims_clerk", "shift_lead", "teacher", "gemini_reflex"}
    assert {a.model for a in agents} == {workflow.GEMINI_MODEL}
    if not os.environ.get("BELT_GEMINI_MODEL"):
        assert workflow.GEMINI_MODEL == "gemini-3.5-flash-lite"


def test_gemini_model_env_overrides_every_agent():
    code = ("import sys; sys.path.insert(0, '.');"
            "from belt import workflow, teach, h2h;"
            "print(sorted({a.model for a in (workflow.second_look, workflow.claims_clerk, workflow.shift_lead,"
            " teach.teacher, h2h.gemini_reflex)}))")
    env = {**os.environ, "BELT_GEMINI_MODEL": "gemini-test-model"}
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True,
                         timeout=120)
    assert out.returncode == 0, out.stderr[-500:]
    assert out.stdout.strip().splitlines()[-1] == "['gemini-test-model']"


def test_flash_lite_price():
    assert floor.GEMINI_PRICE_IN == 0.30 and floor.GEMINI_PRICE_OUT == 2.50
    assert floor.gemini_cost(1_000_000, 0, 0) == pytest.approx(0.30)
    assert floor.gemini_cost(0, 500_000, 500_000) == pytest.approx(2.50)   # thinking bills as output


# ── webcam mode is gone ─────────────────────────────────────────────────────

@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    from belt import server
    monkeypatch.setenv("BELT_REPLAY", "1")
    with TestClient(server.app) as c:
        yield c


def test_webcam_routes_gone(client):
    from belt import server
    assert client.post("/api/camera", json={"fallback": "crushed"}).status_code in (404, 405)
    assert client.get("/api/photos/LIVE-INTACT.jpg").status_code == 404
    assert client.get("/api/photo/LIVE-CRUSHED.jpg").status_code == 404
    assert not hasattr(server, "camera") and not hasattr(server, "prepare_still")
    assert not hasattr(engine, "live_photo")
    paths = {getattr(r, "path", "") for r in server.app.routes}
    assert not any("camera" in p for p in paths)


def test_run_modes(client):
    for bad in ("model", "webcam", "nope"):
        assert client.post("/api/run", json={"mode": bad}).status_code == 400
