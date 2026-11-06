"""Offline tests for the safety gate: per-action bars, cross-question check, risk tiers, audit sampling,
drift tightening, calibration maths, and the new endpoints (safety, mode-1 judge + Jev comparison, review).

No keys, no network: Jev is faked at judge_photo, Gemini runs in forced replay (BELT_REPLAY=1)."""
import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from belt import calibrate, engine, floor, policy  # noqa: E402

TH = {"abstain": 0.40, "ship": 0.90, "retape": 0.85, "hold": 0.50}


@pytest.fixture(autouse=True)
def clean():
    cfg = dict(floor.SAFETY_CONFIG)
    floor.reset_thresholds()
    floor.HUMAN.reset()
    floor.SAFETY.reset("test-seed")
    policy.reset()
    yield
    floor.SAFETY_CONFIG.update(cfg)
    floor.reset_thresholds()
    floor.HUMAN.reset()
    floor.SAFETY.reset()
    policy.reset()


def route(choice, conf, damaged=0.05, risk=0.1, declared="Paperback books, 3", handling="", drift=None):
    return floor.gate_route(choice, conf, damaged, risk, declared, handling, th={**TH, "auto": TH["ship"]},
                            drift=drift)


# ── a. per-action, asymmetric bars ──────────────────────────────────────────

def test_ship_needs_a_higher_bar_than_hold():
    assert route("ship", 0.85)["lane"] == "gemini" and route("ship", 0.85)["rule"] == "below_ship_bar"
    assert route("hold", 0.85, damaged=0.9, risk=1.6)["lane"] == "auto"
    assert route("hold", 0.55, damaged=0.9, risk=1.6)["rule"] == "auto_hold"      # hold: the safe action
    assert route("ship", 0.90)["rule"] == "auto_ship" and route("ship", 0.8999)["lane"] == "gemini"
    assert route("retape", 0.86)["rule"] == "auto_retape" and route("retape", 0.84)["lane"] == "gemini"
    assert floor.DESIGN["ship"] > floor.DESIGN["retape"] > floor.DESIGN["hold"]


@pytest.mark.parametrize("choice", ["return", "file_claim", "issue_refund"])
def test_return_and_refund_never_auto(choice):
    r = route(choice, 0.99, damaged=0.95, risk=1.9)
    assert r["lane"] == "gemini" and r["rule"] == "return_never_auto"
    assert route(choice, 0.2)["lane"] == "human"                  # abstain still wins below 0.40


def test_abstain_goes_to_a_person():
    r = route("ship", 0.39)
    assert r["lane"] == "human" and r["rule"] == "abstain_low_confidence"


# ── b. cross-question consistency ───────────────────────────────────────────

@pytest.mark.parametrize("damaged,risk", [(0.50, 0.1), (0.9, 0.1), (0.05, 1.2), (0.05, 1.9)])
def test_cross_check_blocks_a_confident_ship(damaged, risk):
    r = route("ship", 0.99, damaged=damaged, risk=risk)
    assert r["lane"] == "gemini" and r["rule"] == "cross_check_disagree"
    assert route("retape", 0.99, damaged=damaged, risk=risk)["rule"] == "cross_check_disagree"


def test_cross_check_does_not_fire_on_consistent_answers():
    assert route("ship", 0.99, damaged=0.49, risk=1.19)["lane"] == "auto"
    assert route("hold", 0.99, damaged=0.95, risk=1.9)["lane"] == "auto"   # hold + damage agree


# ── c. risk tiers from context ──────────────────────────────────────────────

def test_tiers_from_declared_and_marks():
    assert floor.tier_of("Glass vase", "")["tier"] == "fragile"
    assert floor.tier_of("Picture frame, glass front", "")["tier"] == "fragile"
    assert floor.tier_of("Laptop, 15 inch", "")["tier"] == "high_value"
    assert floor.tier_of("Lithium battery pack", "")["tier"] == "high_value"
    assert floor.tier_of("Cotton T-shirts", "")["tier"] == "standard"
    assert floor.tier_of("Phone case", "")["tier"] == "standard"          # an accessory, not the device
    assert floor.tier_of("Smartphone, new in box", "")["tier"] == "high_value"
    assert floor.tier_of("Phone, 128 GB", "")["tier"] == "high_value"
    assert floor.tier_of("Stopwatch", "")["tier"] == "standard"
    t = floor.tier_of("Cotton T-shirts", "FRAGILE (Handle with care) mark on the box")
    assert t["tier"] == "fragile" and t["fragile_mark"] and t["mismatch"]
    assert not floor.tier_of("Wine glasses, 2", "FRAGILE mark on the box")["mismatch"]


def test_fragile_tier_never_auto_ships():
    r = route("ship", 0.99, declared="Glass vase")
    assert r["lane"] == "gemini" and r["rule"] == "fragile_no_auto_ship" and r["legacy_lane"] == "auto"
    assert route("hold", 0.6, damaged=0.7, risk=1.3, declared="Glass vase")["lane"] == "auto"
    assert route("retape", 0.9, declared="Glass vase")["lane"] == "gemini"     # retape bar +0.10 = 0.95
    assert route("retape", 0.95, declared="Glass vase")["rule"] == "auto_retape"


def test_high_value_tier_raises_the_bar():
    assert route("ship", 0.93, declared="Laptop, 15 inch")["rule"] == "below_ship_bar"   # bar 0.95
    r = route("ship", 0.95, declared="Laptop, 15 inch")
    assert r["rule"] == "auto_ship" and r["bar"] == 0.95 and r["tier"] == "high_value"


def test_marks_vs_declared_goes_to_a_person_and_beats_gemini_checks():
    r = route("ship", 0.97, declared="Cotton T-shirts", handling="FRAGILE mark on the box")
    assert r["lane"] == "human" and r["rule"] == "marks_vs_declared"
    fired = {c["rule"] for c in r["checks"] if c["fired"]}
    assert fired == {"marks_vs_declared", "fragile_no_auto_ship"}    # every check runs, the most cautious wins
    assert len(r["checks"]) == 7 and all({"rule", "fired", "lane", "detail"} <= set(c) for c in r["checks"])


def test_seeded_confidently_wrong_case_old_gate_ships_new_gate_catches():
    """P-S01: crop of torn P-0125 (damage out of frame), FRAGILE sticker, declared Cotton T-shirts.
    Live Jev said ship 0.91, damaged 0.05, risk 0.21 (2026-10-30). The key says hold."""
    seeded = {p["id"]: p for p in engine.seeded_parcels()}["P-S01"]
    assert seeded["truth"]["action"] == "hold"
    r = floor.gate_route("ship", 0.91, 0.05, 0.21, seeded["declared"], engine.handling_marks(seeded),
                         th={**TH, "auto": TH["ship"]})
    assert r["legacy_lane"] == "auto"                                   # old gate: auto-ship ...
    assert engine.grade(seeded["truth"], "ship") == "near_miss"         # ... a near-miss
    assert r["lane"] == "human" and r["rule"] == "marks_vs_declared"   # new gate: a person checks
    # without the mark, the fragile-words tier alone would not catch a T-shirt ship at 0.91: say so
    plain = floor.gate_route("ship", 0.91, 0.05, 0.21, seeded["declared"], "", th={**TH, "auto": TH["ship"]})
    assert plain["lane"] == "auto"


# ── d + f. audit sampling and drift tightening ──────────────────────────────

def test_audit_pick_is_deterministic_and_close_to_the_rate():
    ids = [f"P-{i:05d}" for i in range(4000)]
    picked = [i for i in ids if floor.audit_pick(i, "seed-a", 0.10)]
    assert 0.08 < len(picked) / len(ids) < 0.12
    assert picked == [i for i in ids if floor.audit_pick(i, "seed-a", 0.10)]      # same seed, same sample
    assert picked != [i for i in ids if floor.audit_pick(i, "seed-b", 0.10)]      # new run, new sample
    assert not any(floor.audit_pick(i, "seed-a", 0.0) for i in ids)
    assert all(floor.audit_pick(i, "seed-a", 1.0) for i in ids)


def test_audit_flags_disagreement_and_grades_against_the_label():
    m = floor.SAFETY
    m.start_audit("P-0101", "ship")
    rec, change = m.finish_audit("P-0101", {"action": "ship", "needs_human": False}, truth="ship")
    assert not rec["flagged"] and not rec["error"] and change is None
    m.start_audit("P-0102", "ship")
    rec, _ = m.finish_audit("P-0102", {"action": "hold", "needs_human": False}, truth="ship")
    assert rec["flagged"] and not rec["error"]                 # Gemini disagreed, but Jev was right
    st = m.stats()["audit"]
    assert st["n"] == 2 and st["flagged"] == 1 and st["errors"] == 0 and st["observed_error"] == 0
    assert st["ucb95"] == calibrate.clopper_pearson_upper(0, 2)


def test_drift_tightens_then_pauses_and_the_gate_follows():
    floor.set_safety_config(alpha=0.02)
    m = floor.SAFETY
    for i in range(3):
        m.start_audit(f"P-01{i:02d}", "ship")
        m.finish_audit(f"P-01{i:02d}", {"action": "ship"}, truth="ship")
    assert m.drift()["state"] == "normal"
    m.start_audit("P-0110", "ship")
    _, change = m.finish_audit("P-0110", {"action": "hold"}, truth="hold")     # a confident mistake
    assert change and change["state"] == "tightened" and change["offset"] == floor.TIGHTEN_STEP
    d = m.drift()
    assert route("ship", 0.92, drift=d)["lane"] == "gemini"                   # bar 0.90 -> 0.95
    assert route("ship", 0.96, drift=d)["rule"] == "auto_ship"
    assert route("hold", 0.55, damaged=0.9, risk=1.6, drift=d)["lane"] == "auto"   # hold never tightens
    m.start_audit("P-0111", "ship")
    _, change = m.finish_audit("P-0111", {"action": "hold"}, truth="hold")
    assert change["state"] == "paused"
    r = route("ship", 0.99, drift=m.drift())
    assert r["lane"] == "gemini" and r["rule"] == "drift_paused"
    assert m.stats()["audit"]["errors"] == 2 and len(m.stats()["drift"]["history"]) == 2
    assert m.reset_drift()["state"] == "normal"
    assert route("ship", 0.99, drift=m.drift())["lane"] == "auto"


def test_drift_stays_quiet_within_budget():
    floor.set_safety_config(alpha=0.05)
    m = floor.SAFETY
    for i in range(40):
        m.start_audit(f"A-{i}", "ship")
        m.finish_audit(f"A-{i}", {"action": "ship"}, truth="hold" if i == 39 else "ship")
    assert m.stats()["audit"]["errors"] == 1 and m.drift()["state"] == "normal"   # 1 <= 0.05 x 40
    # the same single mistake as the FIRST audit trips the alarm: 1 > 0.05 x 1 (small n is unforgiving)
    m.reset()
    m.start_audit("B-0", "ship")
    assert m.finish_audit("B-0", {"action": "ship"}, truth="hold")[1]["state"] == "tightened"


def test_person_relabels_an_audit():
    m = floor.SAFETY
    m.start_audit("P-0101", "ship")
    m.finish_audit("P-0101", {"action": "hold"}, truth="ship")
    rec, change = m.relabel("P-0101", "hold")
    assert rec["label_source"] == "person" and rec["error"] and change["state"] == "tightened"
    assert m.relabel("P-9999", "hold") == (None, None)


# ── e. calibration maths ────────────────────────────────────────────────────

def test_clopper_pearson_and_rule_of_three():
    assert calibrate.clopper_pearson_upper(0, 30) == pytest.approx(1 - 0.05 ** (1 / 30), abs=1e-3)   # 0.0950
    assert calibrate.clopper_pearson_upper(0, 149) <= 0.02 < calibrate.clopper_pearson_upper(0, 140)
    assert calibrate.n_needed(0.02) == 149 and calibrate.n_needed(0.05) == 59
    assert calibrate.clopper_pearson_upper(2, 2) == 1.0 and calibrate.clopper_pearson_upper(0, 0) is None
    assert 0.0 < calibrate.clopper_pearson_upper(1, 20) < 0.25


def test_harmful_is_asymmetric():
    assert calibrate.harmful("hold", "ship") and calibrate.harmful("ship", "retape")
    assert not calibrate.harmful("ship", "hold")          # a needless hold is safe: a person looks
    assert not calibrate.harmful("hold", "hold")


def test_pick_bar_lowest_bar_under_alpha():
    pts = [(0.95, False), (0.92, False), (0.91, False), (0.88, True), (0.85, False), (0.6, True)]
    assert calibrate.pick_bar(pts, alpha=0.0, n_min=3) == {"bar": 0.91, "covered": 3, "errors": 0}
    assert calibrate.pick_bar(pts, alpha=0.25, n_min=3)["bar"] == 0.85     # 1 / 5 = 0.20 <= 0.25
    assert calibrate.pick_bar(pts, alpha=0.0, n_min=4)["bar"] is None       # 3 clean ones < n_min


def _sample(i, choice, conf, truth, declared="Paperback books", damaged=0.05, risk=0.1):
    return {"id": f"S{i}", "choice": choice, "confidence": conf, "truth": truth, "declared": declared,
            "handling": "", "damaged": damaged, "risk": risk}


def test_calibrate_raises_the_ship_bar_above_a_confident_mistake_and_respects_floors():
    samples = ([_sample(i, "ship", round(0.97 - i * 0.01, 2), "ship") for i in range(5)]           # 0.97 .. 0.93
               + [_sample(10, "ship", 0.92, "hold")]                                       # confident mistake
               + [_sample(11, "ship", 0.85, "ship"), _sample(12, "hold", 0.45, "ship", damaged=0.8, risk=1.5),
                  _sample(13, "hold", 0.6, "hold", damaged=0.8, risk=1.5), _sample(14, "retape", 0.9, "retape")])
    cal = calibrate.calibrate(samples, alpha=0.02, n_min=3)
    ship = cal["per_action"]["ship"]
    assert ship["data_bar"] == 0.93 and ship["in_force"] == 0.93 and ship["covered"] == 5 and ship["errors"] == 0
    hold = cal["per_action"]["hold"]
    assert hold["data_bar"] is None or hold["in_force"] >= floor.FLOORS["hold"]
    assert cal["in_force"]["retape"] >= floor.FLOORS["retape"]
    assert cal["legacy"]["auto_errors"] == 1 and cal["gate"]["auto_errors"] == 0   # 0.92 mistake: old ships it
    assert cal["n_needed_for_alpha"] == 149 and "far too few" in cal["note"]
    assert sum(cal["gate"]["lanes"].values()) == len(samples)


def test_calibrate_small_set_can_only_tighten():
    samples = [_sample(i, "ship", round(0.5 + i * 0.01, 2), "ship") for i in range(20)]   # all right, low conf
    cal = calibrate.calibrate(samples, alpha=0.02)
    ship = cal["per_action"]["ship"]
    assert ship["data_bar"] == 0.5 and not ship["proven"] and ship["data_ucb95"] > 0.02
    assert cal["in_force"]["ship"] == floor.DESIGN["ship"]          # 20 clean parcels prove nothing at 2%


def test_calibrate_large_clean_set_may_loosen_but_not_below_the_floor():
    samples = [_sample(i, "ship", round(0.5 + (i % 50) * 0.01, 2), "ship") for i in range(400)]
    cal = calibrate.calibrate(samples, alpha=0.02)
    ship = cal["per_action"]["ship"]
    assert ship["proven"] and ship["data_ucb95"] <= 0.02
    assert cal["in_force"]["ship"] == floor.FLOORS["ship"] == 0.80     # never below the old single bar


# ── the whole workflow, offline: audit in shadow, drift, seeded case ────────

FAKE = {  # parcel -> (choice, confidence, damaged, risk)
    "P-0101": ("ship", 0.95, 0.05, 0.1),      # Paperback books: auto_ship, right
    "P-0102": ("ship", 0.60, 0.10, 0.2),      # gemini
    "P-0103": ("retape", 0.93, 0.10, 0.3),    # Hoodie, key ship: auto_retape, WRONG -> audit error -> drift
    "P-0104": ("ship", 0.97, 0.05, 0.1),      # auto_ship, right
    "P-S01": ("ship", 0.91, 0.05, 0.21),      # the seeded confidently-wrong case (live Jev answer)
}


@pytest.fixture
def offline(monkeypatch):
    from belt import calls, jev
    monkeypatch.setenv("BELT_REPLAY", "1")
    monkeypatch.setenv("BELT_REPLAY_GEMINI_SECONDS", "0")
    monkeypatch.delenv("BELT_RECORD", raising=False)
    monkeypatch.setattr(jev, "replay_get", lambda kind, key: None)

    async def judge_photo(client, key, photo, declared, handling, claim_ready, **kw):
        choice, conf, damaged, risk = FAKE[key]
        probs = {k: 0.03 for k in ("ship", "retape", "hold", "return")}
        probs[choice] = 0.91
        rec = calls.start("jev", model="jev-1.14.0", purpose="belt", parcel=key, live=True)
        calls.finish(rec, ms=100, input_tokens=1800, output_tokens=90)
        return {"action": {"choice": choice, "confidence": conf, "probabilities": probs},
                "damaged": {"noul": damaged}, "risk": {"score": risk}, "model": "jev-1.14.0",
                "input_tokens": 1800, "output_tokens": 90, "ms": 100, "replay": False, "call_id": rec["id"]}
    monkeypatch.setattr(jev, "judge_photo", judge_photo)
    monkeypatch.setattr(engine, "MAX_TICKS", 30)


def _run(limit=4, seed=False):
    from belt.run import run_workflow
    events = []
    asyncio.run(run_workflow("workflow", lambda e: None, limit, 0, stream=events.append, seed=seed))
    return events


def test_audit_runs_in_shadow_and_drift_tightens_the_live_gate(offline):
    floor.set_safety_config(audit_rate=1.0, alpha=0.02)     # audit every auto parcel
    ev = _run(4)
    routes = {e["parcel_id"]: e for e in ev if e["type"] == "route" and "escalated_from" not in e}
    assert {k: r["rule"] for k, r in routes.items()} == {
        "P-0101": "auto_ship", "P-0102": "below_ship_bar", "P-0103": "auto_retape", "P-0104": "auto_ship"}
    assert all({"rule", "tier", "checks", "legacy_lane", "effective"} <= set(r) for r in routes.values())
    starts = [e["parcel_id"] for e in ev if e["type"] == "audit" and e["phase"] == "start"]
    done = {e["parcel_id"]: e for e in ev if e["type"] == "audit" and e["phase"] == "done"}
    assert starts == ["P-0101", "P-0103", "P-0104"] and set(done) == set(starts)
    # an audited auto parcel is not skipped: Gemini really looks (in shadow), and the decision stands
    skipped = {e["parcel_id"] for e in ev if e["type"] == "gemini_skipped"}
    assert skipped.isdisjoint(starts)
    looks = [e["parcel_id"] for e in ev if e["type"] == "llm_start" and e["agent"] == "second_look"]
    assert sorted(looks) == ["P-0101", "P-0102", "P-0103", "P-0104"]
    dec = {(e["parcel_id"], e["decided_by"], e["final_action"]) for e in ev if e["type"] == "decision"}
    assert ("P-0103", "jev", "retape") in dec and not any(d[0] == "P-0103" and d[1] == "gemini" for d in dec)
    assert done["P-0103"]["error"] and done["P-0103"]["label"] == "ship"
    assert done["P-0103"]["label_source"].startswith("answer key")
    drift = [e for e in ev if e["type"] == "drift"]
    assert drift and drift[0]["state"] == "tightened" and drift[0]["effective"]["ship"] == 0.95
    # P-0104 came after the alarm? Either way the shadow review of the flagged one waits for a person
    end = [e for e in ev if e["type"] == "run_end"][-1]["scorecard"]
    assert end["safety"]["audit"]["n"] == 3 and end["safety"]["audit"]["errors"] == 1
    assert end["safety"]["auto_key"]["errors"] == 1 and end["lanes"]["auto"] == 3
    audit_q = [e for e in ev if e["type"] == "human_queue" and e.get("kind") == "audit"]
    assert all(e["auto_action"] for e in audit_q)


def test_seeded_case_live_path_old_gate_would_ship_new_gate_holds(offline):
    floor.set_safety_config(audit_rate=0)
    ev = _run(seed="only")
    r = [e for e in ev if e["type"] == "route"][0]
    assert r["parcel_id"] == "P-S01" and r["legacy_lane"] == "auto"
    assert r["lane"] == "human" and r["rule"] == "marks_vs_declared"
    q = [e for e in ev if e["type"] == "human_queue"][0]
    assert q["rule"] == "marks_vs_declared" and q["kind"] == "decide" and "FRAGILE" in q["handling"]
    end = [e for e in ev if e["type"] == "run_end"][-1]["scorecard"]
    assert end["near_miss"] == 0 and end["lanes"] == {"auto": 0, "gemini": 0, "human": 1}


# ── endpoints ───────────────────────────────────────────────────────────────

@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    from belt import server
    monkeypatch.setenv("BELT_REPLAY", "1")
    monkeypatch.setenv("BELT_REPLAY_GEMINI_SECONDS", "0")
    monkeypatch.delenv("BELT_RECORD", raising=False)
    with TestClient(server.app) as c:
        yield c


def test_safety_endpoint_get_set_and_validate(client):
    s = client.get("/api/safety").json()
    assert set(s["effective"]) >= {"ship", "retape", "hold", "abstain", "paused"}
    assert s["legacy"] == {"auto": 0.80, "abstain": 0.40} and s["never_auto"] == ["return", "file_claim", "issue_refund"]
    assert {"audit", "drift", "rules", "auto_key", "config", "routes", "calibration", "source"} <= set(s)
    r = client.post("/api/safety", json={"ship": 0.93, "audit_rate": 0.25, "alpha": 0.05}).json()
    assert r["thresholds"]["ship"] == 0.93 and r["config"] == {"audit_rate": 0.25, "alpha": 0.05}
    for bad in ({"audit_rate": 2}, {"alpha": "x"}, {"hold": 0.1}, {"ship": -1}):
        assert client.post("/api/safety", json=bad).status_code == 400
    floor.SAFETY.level, floor.SAFETY.offset = 2, 0.05
    assert client.post("/api/safety", json={"reset_drift": True}).json()["drift"]["state"] == "normal"


def test_judge_endpoint_for_mode_1(client):
    key = {p["id"]: p["truth"]["action"] for p in engine.parcels()}
    r = client.post("/api/judge", json={"id": "P-0105", "action": "hold"}).json()
    assert r["outcome"] == "correct" and r["truth"] == key["P-0105"]
    assert client.post("/api/judge", json={"id": "P-0105", "action": "ship"}).json()["outcome"] == "near_miss"
    assert client.post("/api/judge", json={"id": "P-0105", "action": "missed"}).json()["outcome"] == "near_miss"
    assert client.post("/api/judge", json={"id": "P-0101", "action": "missed"}).json()["outcome"] == "missed"
    assert client.post("/api/judge", json={"id": "P-0101", "action": "teleport"}).status_code == 400
    assert client.post("/api/judge", json={"id": "P-9999", "action": "hold"}).status_code == 404


def test_you_jev_endpoint_replay_source(client):
    r = client.post("/api/you/jev", json={"ids": ["P-0101", "P-0105", "P-0112"], "source": "replay"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "replay" and "recorded" in body["source_label"]
    a = {x["id"]: x for x in body["answers"]}
    assert a["P-0105"]["choice"] == "hold" and a["P-0105"]["outcome"] == "correct" and a["P-0105"]["live"] is False
    assert {"lane", "rule", "confidence", "truth", "probabilities"} <= set(a["P-0101"])
    assert body["summary"]["n"] == 3
    assert client.post("/api/you/jev", json={"ids": ["P-0101"], "source": "x"}).status_code == 400


def test_run_seed_validation_and_seeded_photo(client):
    assert client.post("/api/run", json={"mode": "workflow", "seed": "maybe"}).status_code == 400
    r = client.get("/api/photos/P-S01.jpg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"


def test_review_decide_on_an_audit_item_relabels_without_touching_the_score(client):
    floor.SAFETY.start_audit("P-0103", "retape")
    floor.SAFETY.finish_audit("P-0103", {"action": "ship"}, truth="ship")
    floor.HUMAN.add("P-0103", "audit: Jev auto-retape, Gemini says ship", kind="audit", declared="Hoodie",
                    file="photos/real/P-0103.jpg", auto_action="retape")
    r = client.post("/api/human/P-0103", json={"action": "ship"})
    assert r.status_code == 200 and r.json()["outcome"] is None and r.json()["audit"]["label_source"] == "person"
    assert floor.SAFETY.stats()["audit"]["errors"] == 1
