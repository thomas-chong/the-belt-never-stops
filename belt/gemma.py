"""Gemma 4 12B, self-hosted on vLLM /v1/systemone (Cloud Run, 1x L4): the third side of mode 2.

Same request shape as Jev: the same `state` (station, declared contents, handling note, photo) and the
same action question with the same four option texts (reflex.action_question). It answers with
probabilities over the options, like Jev, but they are the model's raw token probabilities, not
calibrated.

Config (env):
  BELT_GEMMA_URL      your Cloud Run service URL (unset = mode 2 runs Jev vs Gemini only); BELT_GEMMA=0 turns it off
  BELT_GEMMA_TIMEOUT  seconds per parcel before Gemma's side shows "no answer" (default 25; a cold start takes minutes)
  BELT_GEMMA_PER_HOUR GPU instance price while up, for the cost column (default 1.42 USD/h, L4 + 8 vCPU + 32 GiB)
Auth: the Cloud Run service is private; an identity token from `gcloud auth print-identity-token`.
"""

from __future__ import annotations

import asyncio
import base64
import os
import subprocess
import time

import httpx

from belt import calls, jev, reflex

DEFAULT_URL = ""  # set BELT_GEMMA_URL to your own service (see README)
MODEL = "gemma-4-12b"
LABEL = "Gemma 4 12B · vLLM on Cloud Run L4"

_token: tuple[str, float] = ("", 0.0)


def url() -> str | None:
    u = os.environ.get("BELT_GEMMA_URL") or DEFAULT_URL
    if os.environ.get("BELT_GEMMA") == "0" or not u:
        return None
    return u.rstrip("/")


def enabled() -> bool:
    return url() is not None


def per_hour() -> float:
    return float(os.environ.get("BELT_GEMMA_PER_HOUR", "1.42"))


def timeout_s() -> float:
    return float(os.environ.get("BELT_GEMMA_TIMEOUT", "25"))


async def _identity_token() -> str:
    global _token
    tok, at = _token
    if tok and time.time() - at < 45 * 60:
        return tok
    out = await asyncio.to_thread(subprocess.check_output, ["gcloud", "auth", "print-identity-token"], text=True,
                                  stderr=subprocess.DEVNULL)
    _token = (out.strip(), time.time())
    return _token[0]


async def warm() -> None:
    """Fire-and-forget at the start of a run, so a scaled-to-zero instance starts booting."""
    u = url()
    if not u:
        return
    try:
        tok = await _identity_token()
        async with httpx.AsyncClient(timeout=600) as c:
            await c.get(f"{u}/health", headers={"Authorization": f"Bearer {tok}"})
    except Exception:  # noqa: BLE001 - warming is best effort
        pass


def _request(pid: str, declared: str, image: bytes, options: dict[str, str]) -> dict:
    q = reflex.action_question(options)["action"]
    return {"model": MODEL,
            "state": {"station": jev.STATION, "declared_contents": declared, "handling": "none noted",
                      "photo": "the attached image"},
            "images": ["data:image/jpeg;base64," + base64.b64encode(image).decode()],
            "questions": {"action": {"type": "choice", "instructions": q.instructions, "criteria": dict(q.criteria)}},
            "chat_template_kwargs": {"enable_thinking": False}}


async def judge(pid: str, declared: str, image: bytes, options: dict[str, str], photo_url: str | None) -> dict:
    """Plain answer {action, probabilities, confidence, ms, tokens, call_id, live}. Replay on failure if recorded."""
    u = url()
    rec = calls.start("gemma", model=MODEL, purpose="head-to-head", parcel=pid, declared=declared, live=True,
                      photo_url=photo_url, thumb=calls.thumbnail(image), image_bytes=len(image), handling="none noted")
    body = _request(pid, declared, image, options)
    try:
        if os.environ.get("BELT_REPLAY") == "1":
            raise RuntimeError("replay forced (BELT_REPLAY=1)")
        tok = await _identity_token()
        t0 = time.perf_counter()
        async with httpx.AsyncClient(timeout=timeout_s()) as c:
            r = await c.post(f"{u}/v1/systemone", json=body, headers={"Authorization": f"Bearer {tok}"})
        ms = round((time.perf_counter() - t0) * 1000)
        r.raise_for_status()
        data = r.json()
        a = data["answers"]["action"]
        usage = data.get("usage") or {}
        out = {"action": a["choice"], "confidence": float(a["confidence"]),
               "probabilities": {k: float(v) for k, v in (a.get("probabilities") or {}).items()},
               "ms": ms, "tokens_in": int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
               "tokens_out": int(usage.get("completion_tokens") or usage.get("output_tokens") or 0),
               "live": True, "model": data.get("model") or MODEL}
        calls.finish(rec, ms=ms, model=out["model"], input_tokens=out["tokens_in"], output_tokens=out["tokens_out"],
                     answers={"action": a})
        jev.replay_put("gemma", pid, {k: v for k, v in out.items() if k != "live"})
        out["call_id"] = rec["id"]
        return out
    except Exception as exc:  # noqa: BLE001 - a failed side is shown, never invented
        err = "timed out (cold start? the GPU instance may still be booting)" if isinstance(
            exc, httpx.TimeoutException) else f"{type(exc).__name__}: {str(exc)[:160]}"
        cached = jev.replay_get("gemma", pid)
        if cached is None:
            calls.finish(rec, live=False, status="error", error=err)
            raise RuntimeError(err) from exc
        calls.finish(rec, live=False, ms=cached.get("ms"), model=MODEL, error=err,
                     replay_note="Recorded Gemma answer from belt/replay.json. ")
        return {**cached, "live": False, "call_id": rec["id"]}
