"""The belt: parcels, the hidden answer key, the scorecard. No model calls here."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "belt" / "manifest.json"                 # synthetic placeholders (belt/photos.py)
REAL_MANIFEST = ROOT / "photos" / "real" / "manifest.json"  # real photos, same shape, when present
PLACEHOLDER_DIR = ROOT / "photos" / "placeholder"
PRICE_PER_MILLION_INPUT = 0.042      # Jev, https://docs.typesafe.ai/models.md (output tokens free)

ACTIONS = ["ship", "spot_check", "retape", "hold", "return", "file_claim"]


def manifest_path() -> Path:
    """photos/real/manifest.json when it exists (and parses), else the placeholder manifest."""
    if REAL_MANIFEST.is_file():
        try:
            json.loads(REAL_MANIFEST.read_text())
            return REAL_MANIFEST
        except (OSError, ValueError) as exc:
            print(f"photos/real/manifest.json not usable ({exc}); using placeholders")
    return MANIFEST


def _resolve(file: str, base: Path) -> str:
    """A manifest file path -> path relative to ROOT. Accepts ROOT-relative or manifest-relative paths."""
    for cand in (ROOT / file, base / file, base / Path(file).name):
        if cand.is_file():
            try:
                return str(cand.resolve().relative_to(ROOT))
            except ValueError:
                return str(cand.resolve())
    return file


def load_manifest(path: Path | None = None) -> dict:
    path = path or manifest_path()
    m = json.loads(path.read_text())
    for p in m.get("parcels", []):
        p["file"] = _resolve(p["file"], path.parent)
    if isinstance(m.get("live"), dict):
        m["live"] = {k: _resolve(v, path.parent) for k, v in m["live"].items() if isinstance(v, str)}
    m["_path"] = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)
    m["_real"] = path in (REAL_MANIFEST, ROOT / "photos" / "seeded" / "manifest.json")
    return m


def _photo_credit(c) -> str:
    """One short line for a per-photo credit dict (title, author, license, site)."""
    if isinstance(c, str):
        return c.strip()
    if not isinstance(c, dict):
        return ""
    bits = [c.get("author"), c.get("license"), c.get("site")]
    return " · ".join(str(b).strip() for b in bits if isinstance(b, str) and b.strip())


def photo_source() -> dict:
    """What the page prints in its photo credit line (plus a per-photo credit when the manifest has one)."""
    m = load_manifest()
    rows = m.get("parcels", []) if isinstance(m.get("parcels"), list) else []
    per_photo = {p["id"]: _photo_credit(p.get("credit")) for p in rows if isinstance(p, dict) and p.get("id")}
    per_photo = {k: v for k, v in per_photo.items() if v}
    credit = m.get("credit") or m.get("credits")
    if not isinstance(credit, str) or not credit.strip():
        credit = ""
        if m["_real"] and per_photo:
            sites = sorted({p["credit"].get("site") for p in rows
                            if isinstance(p, dict) and isinstance(p.get("credit"), dict) and p["credit"].get("site")})
            credit = "reused under their licences" + (f" ({', '.join(sites)})" if sites else "")
        credits_md = ROOT / "photos" / "real" / "CREDITS.md"
        if not credit and m["_real"] and credits_md.is_file():
            for line in credits_md.read_text().splitlines():
                line = line.strip().lstrip("-*> ").strip()
                if line and not line.startswith("#") and not line.startswith("|"):
                    credit = line
                    break
    if not credit:
        credit = (m.get("source") if isinstance(m.get("source"), str) else "") or \
            ("real photos, see photos/real/CREDITS.md" if m["_real"] else "synthetic placeholders drawn by belt/photos.py")
    return {"real": m["_real"], "manifest": m["_path"], "credit": credit[:200],
            "credits_file": "photos/real/CREDITS.md" if m["_real"] else None, "per_photo": per_photo}


def parcels() -> list[dict]:
    return load_manifest()["parcels"]


SEEDED_MANIFEST = ROOT / "photos" / "seeded" / "manifest.json"


def seeded_parcels() -> list[dict]:
    """Seeded safety-gate cases (photos/seeded/), built by context from the real photos. Not on the belt
    unless a run asks for them (POST /api/run {seed: true | "only"})."""
    if not SEEDED_MANIFEST.is_file():
        return []
    return load_manifest(SEEDED_MANIFEST)["parcels"]


def find_parcel(pid: str) -> dict | None:
    for p in parcels() + seeded_parcels():
        if p["id"] == pid:
            return p
    return None


def handling_marks(parcel: dict) -> str:
    """Handling marks on the box, as the gate sees them (from the manifest's sticker fields, standing in
    for a marks / label scan). Jev is not given these: it gets the photo and the declared contents."""
    if parcel.get("fragile_sticker"):
        return f"{parcel.get('sticker') or 'FRAGILE'} mark on the box"
    return ""


MAX_TICKS = len(parcels()) if MANIFEST.exists() else 30


def grade(truth: dict, action: str) -> str:
    """correct | safe | wrong | near_miss.  near_miss = auto-shipped a damaged parcel."""
    want = truth["action"]
    damaged_truth = want in ("hold", "return")
    if action == "ship" and damaged_truth:
        return "near_miss"
    ok = {
        "ship": {"ship", "spot_check"},
        "retape": {"retape"},
        "hold": {"hold", "file_claim", "issue_refund"},
        "return": {"return", "file_claim", "issue_refund"},
    }[want]
    if action in ok:
        return "correct"
    if action in ("hold", "spot_check"):
        return "safe"            # a person looks at it: slower, but nothing bad ships
    return "wrong"


class Scorecard:
    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.claims_filed = 0
        self.jev_ms = 0
        self.jev_tokens = 0
        self.jev_calls = 0
        self.gemini_calls = 0
        self.gemini_tokens = 0
        self.replays = 0

    def add(self, parcel: dict, decision: dict, jev: dict | None) -> dict:
        outcome = grade(parcel["truth"], decision["action"])
        if decision["action"] == "file_claim":
            self.claims_filed += 1
        if jev:
            self.jev_calls += 1
            self.jev_ms += int(jev.get("ms", 0))
            self.jev_tokens += int(jev.get("input_tokens", 0))
            self.replays += 1 if jev.get("replay") else 0
        row = {"id": parcel["id"], "action": decision["action"], "outcome": outcome,
               "truth": parcel["truth"]["action"]}
        self.rows.append(row)
        return row

    def update(self, parcel_id: str, action: str) -> dict | None:
        """A later decision for a parcel (Gemini's second look, a person, a filed claim): regrade its row."""
        for row in self.rows:
            if row["id"] == parcel_id:
                if action in ("file_claim", "issue_refund") and row["action"] not in ("file_claim", "issue_refund"):
                    self.claims_filed += 1
                row["action"] = action
                row["outcome"] = grade({"action": row["truth"]}, action)
                return row
        return None

    def snapshot(self) -> dict[str, Any]:
        n = len(self.rows)
        count = lambda k: sum(1 for r in self.rows if r["outcome"] == k)
        return {
            "parcels": n, "correct": count("correct"), "safe": count("safe"), "wrong": count("wrong"),
            "near_miss": count("near_miss"), "claims_filed": self.claims_filed,
            "jev_calls": self.jev_calls, "jev_ms_avg": round(self.jev_ms / self.jev_calls) if self.jev_calls else 0,
            "jev_tokens": self.jev_tokens,
            "jev_cost_usd": round(self.jev_tokens * PRICE_PER_MILLION_INPUT / 1_000_000, 6),
            "gemini_calls": self.gemini_calls, "gemini_tokens": self.gemini_tokens, "replays": self.replays,
        }
