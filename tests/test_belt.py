"""Offline tests: no API keys, no network."""
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from belt import engine, label, photos, reflex  # noqa: E402


def answers(choice, conf, probs=None, damaged=0.1, risk=0.2, box=None):
    a = {"action": {"choice": choice, "confidence": conf, "probabilities": probs or {choice: 0.9}},
         "damaged": {"noul": damaged}, "risk": {"score": risk}}
    if box is not None:
        a["where"] = box
    return a


def test_sure_ship_ships():
    assert reflex.choose(answers("ship", 0.93), False)["action"] == "ship"


def test_ship_in_spot_check_band():
    d = reflex.choose(answers("ship", 0.60), False)
    assert d["action"] == "spot_check" and "0.80" in d["why"]


def test_ship_exactly_auto_ship_ships():
    assert reflex.choose(answers("ship", reflex.AUTO_SHIP), False)["action"] == "ship"


def test_unsure_and_severe_falls_back_to_hold():
    d = reflex.choose(answers("ship", 0.30, risk=1.8), False)
    assert d["action"] == "hold" and d["fallback"]


def test_unsure_but_low_risk_keeps_choice():
    d = reflex.choose(answers("retape", 0.30, risk=0.5), False)
    assert d["action"] == "retape" and not d["fallback"]


def test_confidence_not_probability_is_compared():
    # top probability 0.85 looks safe, but confidence 0.35 is under TRUST 0.40
    d = reflex.choose(answers("retape", 0.35, probs={"retape": 0.85}, risk=1.6), False)
    assert d["action"] == "hold"


def test_claim_filed_only_when_ready_and_damaged():
    assert reflex.choose(answers("hold", 0.9, damaged=0.8), True)["action"] == "file_claim"
    assert reflex.choose(answers("hold", 0.9, damaged=0.5), True)["action"] == "hold"
    assert reflex.choose(answers("hold", 0.9, damaged=0.8), False)["action"] == "hold"
    assert reflex.choose(answers("file_claim", 0.9, damaged=0.8), False)["action"] == "hold"


def test_fragile_handling_blocks_retape():
    assert reflex.choose(answers("retape", 0.9), False, handling="fragile")["action"] == "hold"


@pytest.mark.parametrize("handling", [None, "", "none noted"])
def test_handling_none_safe(handling):
    assert reflex.choose(answers("retape", 0.9), False, handling=handling)["action"] == "retape"


def test_box_only_when_damaged():
    box = {"box": {"top": .1, "bottom": .5, "left": .1, "right": .5}, "confidence": None}
    assert reflex.choose(answers("hold", .9, damaged=.9, box=box), False)["box"] == box
    assert reflex.choose(answers("ship", .9, damaged=.1, box=box), False)["box"] is None


def test_questions_offer_file_claim_only_when_ready():
    assert "file_claim" not in reflex.parcel_questions(False)["action"].criteria
    assert "file_claim" in reflex.parcel_questions(True)["action"].criteria
    assert "where" not in reflex.parcel_questions(False, box=False)


def test_grade():
    T = photos.TRUTH
    assert engine.grade(T["crushed"], "ship") == "near_miss"
    assert engine.grade(T["crushed"], "spot_check") == "safe"
    assert engine.grade(T["crushed"], "file_claim") == "correct"
    assert engine.grade(T["clean"], "spot_check") == "correct"
    assert engine.grade(T["clean"], "hold") == "safe"
    assert engine.grade(T["open_tape"], "ship") == "wrong"
    assert engine.grade(T["leaking"], "return") == "correct"


def test_scorecard_cost():
    s = engine.Scorecard()
    p = {"id": "x", "truth": photos.TRUTH["clean"]}
    s.add(p, {"action": "ship"}, {"ms": 100, "input_tokens": 1_000_000})
    snap = s.snapshot()
    assert snap["jev_cost_usd"] == pytest.approx(0.042) and snap["correct"] == 1 and snap["near_miss"] == 0


def test_label_is_seeded_and_judged():
    a, b = label.new_label(3), label.new_label(3)
    assert a == b and a["carrier"] == "DEVFEST EXPRESS"
    good = {"tracking": a["tracking"].replace(" ", ""), "consignee_zip": a["zip"], "marks": a["marks"]}
    assert label.judge(a, good)["correct"]
    assert not label.judge(a, {**good, "consignee_zip": "UNREADABLE"})["correct"]
    assert label.new_label(label.SMUDGED_INDEX)["smudged"]
    png = label.render_png(a)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert a["tracking"].encode() not in png          # the key is not hidden in the file


def test_placeholder_photos_fit_jev_limits():
    m = engine.load_manifest(engine.MANIFEST)
    assert len(m["parcels"]) == 30
    kinds = {p["kind"] for p in m["parcels"]}
    assert {"clean", "crushed", "ambiguous", "fragile", "dented"} <= kinds
    for p in m["parcels"]:
        w, h = Image.open(ROOT / p["file"]).size
        assert 280 <= min(w, h) and max(w, h) <= 1568
    for pid in photos.DEMO:                       # the context-test / policy stand-ins
        w, h = Image.open(engine.PLACEHOLDER_DIR / f"{pid}.jpg").size
        assert 280 <= min(w, h) and max(w, h) <= 1568


def test_workflow_graph_builds():
    from belt.h2h import h2h_workflow
    from belt.workflow import belt_workflow
    assert belt_workflow.name == "belt" and h2h_workflow.name == "belt_head_to_head"


def test_replay_file_has_no_secrets():
    p = ROOT / "belt" / "replay.json"
    if p.exists():
        text = p.read_text()
        assert "apikey_" not in text and "Bearer" not in text


def test_no_key_means_no_client_and_replay(monkeypatch):
    from belt import jev
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.delenv("BELT_REPLAY", raising=False)
    assert jev.force_replay() and jev.client() is None


# ── the reworked page: proof of inference, context test, policy editor ──────

FAKE_KEY = "apikey_TESTSECRET_never_shown"


def _jev_reply(request):
    """A fake Jev API: reads the real multipart body the SDK sent and answers by the words in it."""
    from belt import calls
    parts = calls._split_multipart(request.headers["content-type"], request.content)
    body = json.loads(parts[0]["data"])
    declared = body["state"]["declared_contents"].lower()
    criteria = body["questions"]["action"]["criteria"]
    fragile = "glass" in declared or "hazmat" in criteria["hold"]
    probs = {"ship": 0.03, "retape": 0.03, "hold": 0.94, "return": 0.0} if fragile else \
        {"ship": 0.55, "retape": 0.05, "hold": 0.40, "return": 0.0}
    choice = max(probs, key=probs.get)
    answers = {
        "action": {"type": "choice", "choice": choice, "confidence": 0.92 if fragile else 0.33, "probabilities": probs},
        "damaged": {"type": "noul", "noul": 0.7},
        "risk": {"type": "score", "score": 0.9, "confidence": 0.5, "legend": {"0": "a", "1": "b", "2": "c"},
                 "probabilities": {"0": 0.2, "1": 0.7, "2": 0.1}},
        "where": {"type": "box", "box": {"top": 0.4, "bottom": 0.6, "left": 0.3, "right": 0.5}, "confidence": 0.3},
    }
    import httpx2
    return httpx2.Response(200, json={"model": "jev-1.14.0", "answers": answers,
                                      "usage": {"input_tokens": 1800, "output_tokens": 90}})


@pytest.fixture
def api(monkeypatch):
    """The FastAPI app with Jev behind a mock transport: real SDK, real capture, no network."""
    import httpx2
    from fastapi.testclient import TestClient
    from typesafe_sdk import AsyncTypeSafeClient

    from belt import calls, jev, policy, server
    monkeypatch.setenv("TYPESAFE_API_KEY", FAKE_KEY)
    monkeypatch.delenv("BELT_REPLAY", raising=False)
    monkeypatch.setattr(jev, "client", lambda: AsyncTypeSafeClient(
        api_key=FAKE_KEY, transport=calls.CaptureTransport(httpx2.MockTransport(_jev_reply))))
    policy.reset()
    with TestClient(server.app) as client:
        yield client
    policy.reset()


def test_context_test_two_live_calls_differ(api):
    r = api.post("/api/context-test", json={"photo": "DEMO-DENTED", "a": "Paperback books, 3", "b": "Glass vase, 2 pcs"})
    assert r.status_code == 200
    j = r.json()
    a, b = j["sides"]
    assert a["declared"] == "Paperback books, 3" and b["declared"] == "Glass vase, 2 pcs"
    assert a["live"] and b["live"] and a["call_id"] != b["call_id"]
    assert a["decision"]["action"] == "spot_check" and b["decision"]["action"] == "hold" and j["different"]


def test_inspector_shows_exact_request_and_response(api):
    side = api.post("/api/context-test", json={"photo": "P-0105"}).json()["sides"][0]
    rec = api.get(f"/api/call/{side['call_id']}").json()
    assert rec["kind"] == "jev" and rec["live"] and rec["model"] == "jev-1.14.0"
    assert rec["input_tokens"] == 1800 and rec["cost_usd"] == pytest.approx(1800 * 0.042 / 1e6)
    req = rec["request"]
    assert req["method"] == "POST" and req["url"].endswith("/v1/systemone")
    assert req["headers"]["typesafe-danger-zone-images"] == "true"
    sent = json.loads(req["parts"][0]["json_text"])                  # the exact JSON part on the wire
    assert sent["state"]["declared_contents"] == "Paperback books, 3"
    assert set(sent["questions"]) == {"action", "damaged", "risk", "where"}
    img = req["parts"][1]
    assert img["content_type"] == "image/jpeg"
    assert img["bytes"] == (engine.ROOT / engine.load_manifest()["parcels"][4]["file"]).stat().st_size
    assert img["base64_head"].startswith("/9j/")                      # JPEG, shown truncated
    assert json.loads(rec["response"]["body_text"])["model"] == "jev-1.14.0"   # verbatim
    assert rec["ms"] >= 0 and rec["wire_ms"] >= 0 and rec["decision"] == "spot_check"
    # the key never leaves the server
    assert FAKE_KEY not in json.dumps(rec) and "redacted" in req["headers"]["authorization"]
    ids = [c["id"] for c in api.get("/api/calls").json()["calls"]]
    assert side["call_id"] in ids
    assert api.get("/api/call/nope").status_code == 404


def test_policy_apply_changes_the_next_call(api):
    before = api.post("/api/policy/probe", json={"photo": "DEMO-BATTERY"}).json()
    assert before["decision"]["action"] == "spot_check" and before["policy_version"] == 1
    r = api.post("/api/policy", json={"preset": "hazmat"})
    assert r.status_code == 200
    state = r.json()
    assert state["version"] == 2 and "hold" in state["changed"] and state["training_images"] == 0
    assert state["thresholds"] == {"TRUST_CONFIDENCE": 0.40, "AUTO_SHIP": 0.80, "SEVERE_RISK": 1.5,
                                   "CLAIM_ON_DAMAGE": 0.60}
    after = api.post("/api/policy/probe", json={"photo": "DEMO-BATTERY"}).json()
    assert after["decision"]["action"] == "hold" and after["policy_version"] == 2
    assert after["first_decision_s"] is not None and after["first_decision_s"] >= 0
    rec = api.get(f"/api/call/{after['call_id']}").json()
    sent = json.loads(rec["request"]["parts"][0]["json_text"])
    assert "hazmat" in sent["questions"]["action"]["criteria"]["hold"]   # the new words went on the wire


def test_policy_edit_validation(api):
    assert api.post("/api/policy", json={"options": {"ship": ""}}).status_code == 400
    assert api.post("/api/policy", json={"options": {"teleport": "x"}}).status_code == 400
    assert api.post("/api/policy", json={"preset": "nope"}).status_code == 400
    ok = api.post("/api/policy", json={"options": {"retape": "Small dents: retape."}, "name": "hand edit"}).json()
    assert ok["options"]["retape"] == "Small dents: retape." and ok["options"]["ship"] == reflex.RESPONSES["ship"]
    assert api.post("/api/policy", json={"preset": "standard"}).json()["changed"] == []


def test_questions_carry_the_policy_text():
    from belt import policy
    q = reflex.parcel_questions(False, policy=policy.PRESETS["peak"]["options"])
    assert q["action"].criteria["retape"].startswith("Peak season")
    assert reflex.parcel_questions(False)["action"].criteria == reflex.RESPONSES


def test_loader_prefers_real_manifest(tmp_path, monkeypatch):
    real = tmp_path / "real"
    real.mkdir()
    Image.new("RGB", (640, 480)).save(real / "R-1.jpg")
    (real / "manifest.json").write_text(json.dumps({"source": "real test", "credit": "Photos: Test Person, CC BY 4.0",
        "parcels": [{"id": "R-1", "file": "R-1.jpg", "declared": "Books", "truth": photos.TRUTH["clean"]}]}))
    monkeypatch.setattr(engine, "REAL_MANIFEST", real / "manifest.json")
    m = engine.load_manifest()
    assert m["_real"] and m["parcels"][0]["id"] == "R-1" and Path(m["parcels"][0]["file"]).is_file()
    assert engine.photo_source()["credit"] == "Photos: Test Person, CC BY 4.0"
    (real / "manifest.json").write_text(json.dumps({"parcels": [{"id": "R-1", "file": "R-1.jpg", "declared": "Books",
        "truth": photos.TRUTH["clean"], "credit": {"author": "A. Person", "license": "CC BY 2.0", "site": "Wikimedia Commons"}}]}))
    src = engine.photo_source()                                # per-photo credit line from the manifest
    assert src["per_photo"] == {"R-1": "A. Person · CC BY 2.0 · Wikimedia Commons"}
    assert "Wikimedia Commons" in src["credit"]
    (real / "manifest.json").write_text("{not json")
    assert not engine.load_manifest()["_real"]                 # broken -> placeholders
    monkeypatch.setattr(engine, "REAL_MANIFEST", tmp_path / "missing.json")
    assert engine.load_manifest()["parcels"][0]["id"] == "P-0101"


def test_server_host_flag(monkeypatch):
    from belt import server
    monkeypatch.delenv("BELT_HOST", raising=False)
    assert server.parse_args([]).host == "127.0.0.1"
    monkeypatch.setenv("BELT_HOST", "0.0.0.0")
    assert server.parse_args([]).host == "0.0.0.0"
    assert server.parse_args(["--host", "10.0.0.5", "--port", "9000"]).port == 9000
