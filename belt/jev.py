"""One Jev 1.14 call per parcel photo, with a replay cache for when the API fails.

The photo goes in `state` once, so all questions share it. Images need the
header TypeSafe-Danger-Zone-Images: true (the API returns 400 without it).
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from typesafe_sdk import AsyncTypeSafeClient, Image

from belt import calls, policy, reflex

ROOT = Path(__file__).resolve().parents[1]
REPLAY = ROOT / "belt" / "replay.json"
MODEL = os.environ.get("BELT_JEV_MODEL", "jev-1.14.0")
IMAGE_HEADER = {"TypeSafe-Danger-Zone-Images": "true"}
STATION = "Sorting belt, inbound dock 3. Decide before the diverter."


def _load_replay() -> dict:
    try:
        return json.loads(REPLAY.read_text())
    except (OSError, ValueError):
        return {"jev": {}, "gemini": {}, "shift_lead": {}}


_replay = _load_replay()


def replay_get(kind: str, key: str):
    return (_replay.get(kind) or {}).get(key)


def replay_put(kind: str, key: str, value: Any) -> None:
    """Only writes when BELT_RECORD=1 (the final rehearsal)."""
    if os.environ.get("BELT_RECORD") != "1":
        return
    try:
        if not isinstance(_replay.get(kind), dict):
            _replay[kind] = {}
        _replay[kind][key] = value
        REPLAY.write_text(json.dumps(_replay, indent=1))
    except (OSError, TypeError) as exc:      # recording must never stop the belt
        print(f"replay not saved: {exc}")


def policy_key(options: dict[str, str]) -> str:
    """'' for the standard policy, else a short hash of the option texts (replay key suffix)."""
    if options == policy.DEFAULT:
        return ""
    return "|p" + hashlib.sha1(json.dumps(options, sort_keys=True).encode()).hexdigest()[:10]


def force_replay() -> bool:
    return os.environ.get("BELT_REPLAY") == "1" or not os.environ.get("TYPESAFE_API_KEY")


def client() -> AsyncTypeSafeClient | None:
    """None in replay mode, or when the SDK cannot be built (no key): judge_photo then replays.

    The client sends through calls.CaptureTransport, so every request and response is kept
    byte for byte for the Inspector (the Authorization header is never stored)."""
    if force_replay():
        return None
    try:
        return AsyncTypeSafeClient(timeout=float(os.environ.get("BELT_JEV_TIMEOUT", "10")),
                                   transport=calls.capture_transport())
    except Exception as exc:  # noqa: BLE001 - e.g. TypeSafeError('No API key was provided')
        print(f"Jev client not built, using replay: {type(exc).__name__}: {exc}")
        return None


async def aclose(c: AsyncTypeSafeClient | None) -> None:
    if c is None:
        return
    try:
        await c.aclose()
    except Exception:  # noqa: BLE001
        pass


async def judge_photo(jev: AsyncTypeSafeClient | None, key: str, photo: bytes | Path, declared: str,
                      handling: str | None, claim_ready: bool, box: bool = True,
                      options: dict[str, str] | None = None, purpose: str = "belt",
                      photo_url: str | None = None, action_only: bool = False) -> dict:
    """Returns plain answers (reflex.plain) plus `call_id`. Falls back to the replay cache on any error.

    `options` = the policy text for each choice (default: the live policy in belt/policy.py).
    Every call, live or replay, is recorded in belt/calls.py and shows in the page's call log.
    `action_only` = head-to-head mode: only the decision question (reflex.action_question), its own
    replay key `h2h|<parcel>`."""
    data = photo.read_bytes() if isinstance(photo, Path) else bytes(photo)
    pol_version = policy.version() if options is None or options == policy.current_options() else None
    options = policy.current_options() if options is None else options
    live = not force_replay() and jev is not None
    replay_key = f"h2h|{key}" if action_only else f"{key}|{int(claim_ready)}"
    rec = calls.start("jev", model=MODEL, purpose=purpose, parcel=key, declared=declared, live=live,
                      policy_version=pol_version, policy_name=policy.STATE["name"] if pol_version else "custom",
                      photo_url=photo_url, thumb=calls.thumbnail(data), image_bytes=len(data),
                      handling=handling or "none noted", claim_ready=claim_ready)
    if live:
        cap: dict = {}
        token = calls.CAPTURE.set(cap)
        started = time.perf_counter()
        try:
            response = await jev.system_one(
                model=MODEL,
                state={"station": STATION, "declared_contents": declared,
                       "handling": handling or "none noted",          # never None
                       "photo": Image(data)},
                questions=(reflex.action_question(options) if action_only else
                           reflex.parcel_questions(claim_ready=claim_ready, box=box, policy=options)),
                extra_headers=IMAGE_HEADER,
            )
            ms = round((time.perf_counter() - started) * 1000)
            out = reflex.plain(response, ms)
            out["call_id"] = rec["id"]
            calls.finish(rec, ms=ms, wire_ms=cap.get("wire_ms"), model=out["model"],
                         input_tokens=out["input_tokens"], output_tokens=out["output_tokens"],
                         request=cap.get("request"), response=cap.get("response"), attempts=cap.get("attempts", 1),
                         answers={k: out[k] for k in ("action", "damaged", "risk", "where") if k in out})
            if pol_version is not None:
                policy.note_decision(pol_version, time.time())
            recorded = {k: v for k, v in out.items() if k != "call_id"}
            if options == policy.DEFAULT:
                replay_put("jev", replay_key, recorded)
            else:                              # an edited / taught policy: kept apart, keyed by its text
                replay_put("jev_policy", replay_key + policy_key(options), recorded)
            return out
        except Exception as exc:  # noqa: BLE001 - any API failure -> replay
            err = f"{type(exc).__name__}: {str(exc)[:160]}"
            rec.update(request=cap.get("request"), response=cap.get("response"))
        finally:
            calls.CAPTURE.reset(token)
    else:
        err = "replay forced (BELT_REPLAY=1 or no TYPESAFE_API_KEY)"
    pkey = policy_key(options)
    by_policy = replay_get("jev_policy", replay_key + pkey) if pkey else None
    cached = by_policy or (replay_get("jev", replay_key) if action_only else
                           replay_get("jev", replay_key) or replay_get("jev", f"{key}|{int(not claim_ready)}"))
    if cached is None:
        calls.finish(rec, live=False, status="error", error=err)
        raise RuntimeError(f"Jev failed and no replay for {key}: {err}")
    out = dict(cached)
    if claim_ready is False and out["action"]["choice"] == "file_claim":
        out["action"] = {**out["action"], "choice": "hold"}
    out.update(replay=True, replay_reason=err, call_id=rec["id"])
    calls.finish(rec, live=False, ms=out.get("ms"), model=out.get("model", MODEL),
                 input_tokens=out.get("input_tokens"), output_tokens=out.get("output_tokens"), error=err,
                 replay_note=("Recorded answer from belt/replay.json under this exact policy text. "
                              if by_policy else
                              "Recorded answer from belt/replay.json (policy text at recording time: standard). ")
                             + "No request was sent for this parcel.",
                 answers={k: out[k] for k in ("action", "damaged", "risk", "where") if k in out})
    return out
