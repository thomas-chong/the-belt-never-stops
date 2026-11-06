"""Set the gate's per-action bars from labelled data, not by feel. Pure maths, no model calls.

For each action Jev can take alone (ship, retape, hold), pick the LOWEST confidence bar t such that,
on the labelled photos, the parcels Jev would decide alone with that action (choice == a and
confidence >= t) contain at most a share `alpha` of harmful mistakes, with at least `n_min` of them.
"Harmful" = engine.grade() says `wrong` or `near_miss` (a hold on a parcel that should ship is `safe`:
a person looks, nothing bad reaches a customer). Then the bar in force is max(data pick, floor):
the gate is never looser than the design floor (ship never below the old 0.80).

This is EMPIRICAL selective risk on a tiny set, not a guarantee. With 0 mistakes in n covered parcels
the one-sided 95% Clopper-Pearson upper bound on the true error rate is about 3/n, so a 2% claim needs
roughly 150 covered parcels of that action with no mistake. So the data may only TIGHTEN the design bar
(belt/floor.py DESIGN) unless the upper bound at the data's pick is itself <= alpha; then it may loosen
it, but never below the hard floor (FLOORS; ship never below the old 0.80). The production method is conformal /
selective risk control (e.g. Learn-then-Test; "Trust or Escalate", Jung et al. 2024), which turns a
calibration set into a probabilistic guarantee on the items not escalated, and only while the new
parcels look like the calibration ones (exchangeable): a new damage type or packaging (distribution
shift) breaks it, which is why the gate also audits and has a drift alarm.
"""

from __future__ import annotations

import math
from typing import Any, Callable

from belt import engine

ACTIONS = ("ship", "retape", "hold")


def binom_cdf(k: int, n: int, p: float) -> float:
    if p <= 0:
        return 1.0
    if p >= 1:
        return 1.0 if k >= n else 0.0
    return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(0, k + 1))


def clopper_pearson_upper(k: int, n: int, conf: float = 0.95) -> float | None:
    """One-sided upper confidence bound on an error rate after k errors in n trials. None when n == 0."""
    if n <= 0:
        return None
    if k >= n:
        return 1.0
    lo, hi = k / n, 1.0
    for _ in range(80):                      # bisection: P(X <= k | p) = 1 - conf
        mid = (lo + hi) / 2
        if binom_cdf(k, n, mid) > 1 - conf:
            lo = mid
        else:
            hi = mid
    return round(hi, 4)


def n_needed(alpha: float, conf: float = 0.95) -> int:
    """Covered parcels with ZERO mistakes needed before the upper bound drops to alpha."""
    return math.ceil(math.log(1 - conf) / math.log(1 - alpha))


def harmful(truth: str, action: str) -> bool:
    return engine.grade({"action": truth}, action) in ("wrong", "near_miss")


def pick_bar(points: list[tuple[float, bool]], alpha: float, n_min: int) -> dict:
    """points = [(confidence, harmful)] for one action. Lowest bar with risk <= alpha and >= n_min covered."""
    for t in sorted({c for c, _ in points}):
        cov = [h for c, h in points if c >= t]
        if len(cov) < n_min:
            break
        errs = sum(cov)
        if errs / len(cov) <= alpha:
            return {"bar": round(t, 3), "covered": len(cov), "errors": errs}
    return {"bar": None, "covered": 0, "errors": 0}


def calibrate(samples: list[dict], alpha: float = 0.02, n_min: int = 3,
              floors: dict[str, float] | None = None, route: Callable[..., dict] | None = None,
              abstain: float = 0.40, source: str = "") -> dict[str, Any]:
    """samples: [{id, choice, confidence, damaged, risk, truth, declared, handling}].

    Returns the per-action result, the bars in force, and what the full gate (all rules) does with
    those bars on the same samples: coverage (share decided alone) and the auto lane's error rate."""
    from belt import floor  # noqa: PLC0415 (floor imports this module)
    floors = floors or floor.FLOORS
    route = route or floor.gate_route
    per: dict[str, dict] = {}
    in_force: dict[str, float] = {}
    for a in ACTIONS:
        pts = [(float(s["confidence"]), harmful(s["truth"], a)) for s in samples if s["choice"] == a]
        pick = pick_bar(pts, alpha, n_min)
        ucb_pick = clopper_pearson_upper(pick["errors"], pick["covered"]) if pick["bar"] is not None else None
        proven = ucb_pick is not None and ucb_pick <= alpha
        if pick["bar"] is None:
            bar, why = max(floor.DESIGN[a], floors[a]), "no bar meets alpha on this data: design bar kept"
        elif proven:
            bar, why = max(pick["bar"], floors[a]), "upper bound <= alpha: data may loosen the bar (not below the floor)"
        else:
            bar, why = max(pick["bar"], floor.DESIGN[a]), ("upper bound > alpha (too few parcels): data may only "
                                                           "tighten the design bar")
        cov = [h for c, h in pts if c >= bar]
        per[a] = {"n_choice": len(pts), "data_bar": pick["bar"], "data_covered": pick["covered"],
                  "data_ucb95": ucb_pick, "proven": proven, "design": floor.DESIGN[a], "floor": floors[a],
                  "in_force": round(bar, 3), "why": why,
                  "covered": len(cov), "errors": sum(cov),
                  "risk": round(sum(cov) / len(cov), 4) if cov else None,
                  "ucb95": clopper_pearson_upper(sum(cov), len(cov)),
                  "harmful_in_choice": sum(h for _, h in pts)}
        in_force[a] = round(bar, 3)
    th = {"abstain": abstain, **in_force}
    th["auto"] = th["ship"]
    lanes = {"auto": 0, "gemini": 0, "human": 0}
    auto_err = 0
    legacy_auto, legacy_err = 0, 0
    rows = []
    for s in samples:
        r = route(s["choice"], s["confidence"], s.get("damaged", 0), s.get("risk", 0), s.get("declared"),
                  s.get("handling"), th=th)
        lanes[r["lane"]] += 1
        bad = r["lane"] == "auto" and harmful(s["truth"], s["choice"])
        auto_err += bad
        lbad = r["legacy_lane"] == "auto" and harmful(s["truth"], s["choice"])
        legacy_auto += r["legacy_lane"] == "auto"
        legacy_err += lbad
        rows.append({"id": s["id"], "choice": s["choice"], "confidence": s["confidence"], "truth": s["truth"],
                     "lane": r["lane"], "rule": r["rule"], "legacy_lane": r["legacy_lane"],
                     "auto_error": bool(bad), "legacy_auto_error": bool(lbad)})
    n = len(samples)
    return {
        "source": source, "n": n, "alpha": alpha, "n_min": n_min, "abstain": abstain,
        "per_action": per, "in_force": in_force,
        "gate": {"lanes": lanes, "coverage": round(lanes["auto"] / n, 3) if n else None,
                 "auto_errors": auto_err,
                 "auto_error_rate": round(auto_err / lanes["auto"], 4) if lanes["auto"] else None,
                 "auto_ucb95": clopper_pearson_upper(auto_err, lanes["auto"])},
        "legacy": {"auto": legacy_auto, "coverage": round(legacy_auto / n, 3) if n else None,
                   "auto_errors": legacy_err},
        "n_needed_for_alpha": n_needed(alpha),
        "rows": rows,
        "note": (f"{n} labelled photos is far too few for a guarantee: with 0 mistakes in n covered parcels the "
                 f"95% upper bound on the error rate is about 3/n, so alpha={alpha:.0%} needs about "
                 f"{n_needed(alpha)} covered parcels per action with no mistake. So here the data can only tighten "
                 "the design bars, never loosen them. In production use conformal / selective risk control (Learn-then-Test, "
                 "'Trust or Escalate', Jung et al. 2024) on a large labelled set; its guarantee holds only while "
                 "new parcels look like the calibration set (it breaks under distribution shift), so keep the "
                 "audit sample and the drift alarm on."),
    }
