"""Named parcel sets for the stage, resolved on the server (POST /api/run {"set": "r3"}).

r3 = Round 3 · The team (tab 4). Twelve parcels, run in this order, chosen so one run at pace 1.0
shows every lane early, with answer keys a person agrees with at a glance (reviewed 2026-11-06: P-0112,
P-0114 and P-0130 left the set because their keys were debatable on stage):
  1  P-0105  Ceramic mugs         crushed, hold, sure      -> auto hold; Jev sees damage -> label read #1
  2  P-0107  Coffee beans         ship                     -> auto or second look
  3  P-0110  Desk lamp            ship ~0.7                -> second look
  4  P-0118  Bluetooth speaker    hold, sure, damaged      -> auto hold; label read #2 is smudged -> BLOCKED
  5  P-S02   Wool socks (seeded)  FRAGILE mark, socks      -> human desk (marks vs declared; the key is SHIP)
  6  P-0111  Hardcover book       ship, sure               -> auto
  7  P-0123  Teapot, ceramic      Jev unsure               -> human desk (dented + fragile: the key is HOLD)
  8  P-0116  Bedding set          ship ~0.6                -> second look
  9  P-0113  Board game           ship, sure               -> auto
  10 P-0128  Glass candle jars    fragile ship             -> second look (fragile parcels never auto-ship)
  11 P-0106  Kitchen towels       flaps open, retape       -> second look
  12 P-0125  Wine glasses         hold, sure, damaged      -> auto hold + claim
P-S02 and P-0128 are the same photo: only the manifest line differs, and so does the lane.
"""

from __future__ import annotations

from belt import engine

SETS: dict[str, list[str]] = {
    "r3": ["P-0105", "P-0107", "P-0110", "P-0118", "P-S02", "P-0111",
           "P-0123", "P-0116", "P-0113", "P-0128", "P-0106", "P-0125"],
}

MAX_IDS = 30


def resolve(set_name: str | None = None, ids: list[str] | None = None) -> list[dict] | None:
    """The parcels to run, in order: `ids` wins over `set`. None when neither is given.
    Raises ValueError (HTTP 400) for an unknown set or parcel id."""
    if ids is not None:
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i.strip() for i in ids):
            raise ValueError("ids must be a non-empty list of parcel ids, e.g. [\"P-0101\", \"P-0112\"]")
        wanted = [i.strip() for i in ids][:MAX_IDS]
    elif set_name is not None:
        if set_name not in SETS:
            raise ValueError(f"unknown set '{set_name}' (known: {', '.join(sorted(SETS))})")
        wanted = SETS[set_name]
    else:
        return None
    out, unknown = [], []
    for pid in wanted:
        p = engine.find_parcel(pid)
        (out.append(p) if p is not None else unknown.append(pid))
    if unknown:
        raise ValueError(f"unknown parcel id(s): {', '.join(unknown)}")
    return out
