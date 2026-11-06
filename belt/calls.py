"""Every model call the server makes, recorded as it happens.

This is the proof that the page is not an animation:

- Jev calls go through `CaptureTransport`, an httpx2 transport that wraps the real one.
  It keeps the exact bytes that went on the wire (multipart: the `request` JSON part and
  the image part) and the exact response body, plus the measured wire round trip.
  The Authorization header is never stored.
- Gemini calls are recorded from ADK callbacks and events: the request (instruction, user
  text, image size), the raw text Gemini streamed back, the usage numbers.

Each record gets an id. A short summary goes to every page over SSE (`{"type": "call"}`);
the full record is served by GET /api/call/{id} for the Inspector.
"""

from __future__ import annotations

import base64
import contextvars
import itertools
import json
import threading
import time
from collections import OrderedDict
from datetime import datetime
from typing import Any, Callable

import httpx2

PRICE_PER_MILLION_INPUT = 0.042      # Jev input tokens; output tokens are free (docs.typesafe.ai/models.md)
KEEP = 400                            # full records kept in memory
SAFE_HEADERS = ("content-type", "content-length", "typesafe-danger-zone-images", "user-agent",
                "x-typesafe-sdk", "typesafe-sdk", "typesafe-runtime", "accept", "x-request-id", "request-id",
                "date", "server")

_ids = itertools.count(1)
_lock = threading.Lock()
RECORDS: "OrderedDict[str, dict]" = OrderedDict()
LISTENERS: list[Callable[[dict], None]] = []

# Set around one Jev call; the transport writes the wire capture into it.
CAPTURE: contextvars.ContextVar[dict | None] = contextvars.ContextVar("belt_capture", default=None)


def _now_label() -> str:
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def new_id(kind: str) -> str:
    return f"{kind[0]}{next(_ids):04d}"


def summary(rec: dict) -> dict:
    keys = ("id", "kind", "at", "model", "ms", "input_tokens", "output_tokens", "total_tokens", "live",
            "status", "purpose", "parcel", "agent", "cost_usd", "error", "policy_version", "decision")
    return {k: rec.get(k) for k in keys if k in rec}


def _emit(rec: dict) -> None:
    event = {"type": "call", **summary(rec)}
    for fn in list(LISTENERS):
        try:
            fn(event)
        except Exception:  # noqa: BLE001 - a broken page must never stop the belt
            pass


def start(kind: str, **fields: Any) -> dict:
    """Open a record (status 'pending'). Pages see it at once, so a slow call shows as in flight."""
    rec = {"id": new_id(kind), "kind": kind, "at": _now_label(), "t_start": time.time(), "status": "pending",
           **fields}
    with _lock:
        RECORDS[rec["id"]] = rec
        while len(RECORDS) > KEEP:
            RECORDS.popitem(last=False)
    _emit(rec)
    return rec


def finish(rec: dict, **fields: Any) -> dict:
    rec.update(fields)
    if rec.get("status") == "pending":
        rec["status"] = "done"
    if rec.get("kind") == "jev" and rec.get("input_tokens") is not None and rec.get("live"):
        rec["cost_usd"] = round(rec["input_tokens"] * PRICE_PER_MILLION_INPUT / 1_000_000, 7)
    _emit(rec)
    return rec


def annotate(call_id: str | None, **fields: Any) -> None:
    """Add what the code did with the answer (the decision), and tell the pages."""
    rec = RECORDS.get(call_id or "")
    if rec is not None:
        rec.update(fields)
        _emit(rec)


def thumbnail(data: bytes, width: int = 320) -> str:
    """A small JPEG data URL of the exact image bytes that were sent."""
    import io  # noqa: PLC0415

    from PIL import Image as PILImage  # noqa: PLC0415
    try:
        img = PILImage.open(io.BytesIO(data)).convert("RGB")
        img.thumbnail((width, width))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=70)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:  # noqa: BLE001
        return ""


def get(call_id: str) -> dict | None:
    return RECORDS.get(call_id)


def recent(n: int = 120) -> list[dict]:
    with _lock:
        return [summary(r) for r in list(RECORDS.values())[-n:]]


# ── the wire capture ─────────────────────────────────────────────────────────

def _split_multipart(content_type: str, body: bytes) -> list[dict]:
    """Split a multipart/form-data body into parts (headers + payload bytes)."""
    if "boundary=" not in content_type:
        return [{"headers": {"Content-Type": content_type}, "data": body}]
    boundary = content_type.split("boundary=", 1)[1].strip().strip('"').encode()
    parts = []
    for chunk in body.split(b"--" + boundary):
        if not chunk or chunk.startswith(b"--"):
            continue
        chunk = chunk[2:] if chunk.startswith(b"\r\n") else chunk
        head, _, data = chunk.partition(b"\r\n\r\n")
        if data.endswith(b"\r\n"):
            data = data[:-2]
        headers = {}
        for line in head.decode("latin-1").split("\r\n"):
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip()] = v.strip()
        parts.append({"headers": headers, "data": data})
    return parts


def describe_request(method: str, url: str, headers: dict, body: bytes) -> dict:
    """The request as the Inspector shows it. JSON parts verbatim; image parts as size + base64 head."""
    shown = {k: v for k, v in headers.items() if k.lower() in SAFE_HEADERS}
    shown["authorization"] = "Bearer ••••••••  (redacted by the page, never stored)"
    parts = []
    for p in _split_multipart(headers.get("content-type", ""), body):
        ctype = p["headers"].get("Content-Type", "")
        disp = p["headers"].get("Content-Disposition", "")
        name = disp.split('name="', 1)[1].split('"', 1)[0] if 'name="' in disp else ""
        data = p["data"]
        if ctype.startswith("application/json"):
            text = data.decode("utf-8", "replace")
            parts.append({"name": name, "content_type": ctype, "bytes": len(data), "json_text": text})
        else:
            b64 = base64.b64encode(data[:60]).decode()
            parts.append({"name": name, "content_type": ctype, "bytes": len(data),
                          "base64_head": b64[:64], "base64_bytes": (len(data) + 2) // 3 * 4})
    return {"method": method, "url": url, "headers": shown, "body_bytes": len(body), "parts": parts}


class CaptureTransport(httpx2.AsyncBaseTransport):
    """Wraps the real async transport. Copies request and response bytes into CAPTURE."""

    def __init__(self, inner: httpx2.AsyncBaseTransport) -> None:
        self.inner = inner

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        cap = CAPTURE.get()
        body = request.content if cap is not None else b""
        started = time.perf_counter()
        response = await self.inner.handle_async_request(request)
        if cap is None:
            return response
        raw = await response.aread()
        wire_ms = round((time.perf_counter() - started) * 1000, 1)
        cap["attempts"] = cap.get("attempts", 0) + 1
        cap["request"] = describe_request(request.method, str(request.url), dict(request.headers), body)
        text = raw.decode("utf-8", "replace")
        try:
            pretty = json.dumps(json.loads(text), indent=2)
        except ValueError:
            pretty = None
        cap["response"] = {"status": response.status_code,
                           "headers": {k: v for k, v in response.headers.items() if k.lower() in SAFE_HEADERS},
                           "body_text": text, "body_pretty": pretty, "bytes": len(raw)}
        cap["wire_ms"] = wire_ms
        # `raw` is already decoded, so drop the encoding headers before handing it back to the SDK.
        headers = [(k, v) for k, v in response.headers.multi_items()
                   if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")]
        return httpx2.Response(status_code=response.status_code, headers=headers, content=raw,
                               request=request, extensions=response.extensions)

    async def aclose(self) -> None:
        await self.inner.aclose()


def capture_transport() -> CaptureTransport:
    """The SDK's own transport settings (TLS context, limits), wrapped."""
    from typesafe_sdk._core.client.aio.client import _ssl_context  # noqa: PLC0415
    from typesafe_sdk._core.config import DEFAULT_LIMITS  # noqa: PLC0415
    return CaptureTransport(httpx2.AsyncHTTPTransport(verify=_ssl_context(), limits=DEFAULT_LIMITS))
