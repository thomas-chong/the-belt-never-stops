"""Shipping labels for the slow branch, like app/sigil.py for spell cards.

A seeded RNG makes a 4x6 label for a fictional carrier, DEVFEST EXPRESS, with
fake names and addresses. The answer key (tracking, ZIP, marks) stays on the
server; the picture is all Gemini gets. `judge()` grades Gemini's ClaimPacket
against the key.

One label in the sequence (SMUDGED_INDEX) has its ZIP smudged on purpose, so
the first read fails and the "retry" route shows on stage.
"""

from __future__ import annotations

import io
import random
import re

from PIL import Image, ImageDraw, ImageFilter, ImageFont

CARRIER = "DEVFEST EXPRESS"
SERVICES = ["GROUND", "2DAY", "OVERNIGHT"]
MARKS = ["FRAGILE", "THIS_SIDE_UP", "LITHIUM_BATTERY", "KEEP_DRY"]
SMUDGED_INDEX = 2          # the 2nd label read in a run is hard to read
FIRST = ["Ana", "Ben", "Chen", "Dara", "Eli", "Fatima", "Gus", "Hana", "Ivan", "June", "Kofi", "Lena"]
LAST = ["Rivera", "Okafor", "Lindqvist", "Moreau", "Tanaka", "Haddad", "Novak", "Silva", "Kim", "Brennan"]
STREETS = ["Maple Test Ave", "Example St", "Sample Blvd", "Placeholder Rd", "Demo Way", "Fictional Pl"]
CONTENTS = ["Ceramic mugs, set of 4", "Glass vase", "Bluetooth speaker", "Picture frame, glass front",
            "Hardcover books", "Olive oil, 2 bottles", "Wine glasses, 2", "Power bank 20000 mAh"]
W, H = 600, 900


def _font(size: int, bold: bool = True):
    names = ["DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"] if bold else \
            ["DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


RECENT: dict[int, dict] = {}   # labels rendered in this server process, by index (for /api/label)


def new_label(index: int, seed: int = 2026, contents: str | None = None) -> dict:
    """The index-th label of a run. Same index and seed -> same label.

    `contents` = the parcel's declared contents, so the label matches the parcel it is on
    (the marks follow the contents). Default: a seeded pick."""
    rng = random.Random(seed * 1000 + index)
    picked = rng.choice(CONTENTS)
    contents = contents or picked
    marks = []
    if any(w in contents.lower() for w in ("ceramic", "glass", "vase", "frame")):
        marks.append("FRAGILE")
    if "power bank" in contents.lower() or "speaker" in contents.lower():
        marks.append("LITHIUM_BATTERY")
    if "oil" in contents.lower():
        marks += ["THIS_SIDE_UP", "KEEP_DRY"]
    if "books" in contents.lower():
        marks.append("KEEP_DRY")
    digits = "".join(str(rng.randint(0, 9)) for _ in range(12))
    return {
        "index": index,
        "carrier": CARRIER,
        "service": rng.choice(SERVICES),
        "tracking": f"DX {digits[:4]} {digits[4:8]} {digits[8:]}",
        "name": f"{rng.choice(FIRST)} {rng.choice(LAST)}",
        "street": f"{rng.randint(10, 999)} {rng.choice(STREETS)}",
        "city": "Brooklyn, NY",
        "zip": f"112{rng.randint(0, 99):02d}",
        "marks": marks or ["NONE"],
        "declared_contents": contents,
        "weight": f"{rng.randint(1, 18)}.{rng.randint(0, 9)} lb",
        "smudged": index == SMUDGED_INDEX,
    }


def render_png(label: dict) -> bytes:
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([8, 8, W - 8, H - 8], outline="black", width=4)
    d.rectangle([8, 8, W - 8, 110], fill="black")
    d.text((26, 24), CARRIER, fill="white", font=_font(40))
    d.text((26, 74), "FICTIONAL CARRIER - DEMO LABEL", fill=(255, 210, 60), font=_font(18))
    d.text((W - 190, 128), label["service"], fill="black", font=_font(34))
    d.text((26, 128), "FROM: DevFest Demo Warehouse", fill="black", font=_font(18, False))
    d.text((26, 152), "1 Sample Dock, Queens, NY 11101", fill="black", font=_font(18, False))
    d.line([8, 190, W - 8, 190], fill="black", width=3)
    d.text((26, 205), "SHIP TO:", fill="black", font=_font(20))
    d.text((26, 235), label["name"].upper(), fill="black", font=_font(34))
    d.text((26, 280), label["street"].upper(), fill="black", font=_font(28, False))
    d.text((26, 318), label["city"].upper(), fill="black", font=_font(28, False))
    d.text((26, 360), "ZIP", fill="black", font=_font(20))
    d.text((90, 350), label["zip"], fill="black", font=_font(52))
    d.line([8, 425, W - 8, 425], fill="black", width=3)
    # decorative barcode
    rng = random.Random(label["tracking"])
    x = 40
    while x < W - 40:
        w = rng.choice([2, 3, 5, 7])
        d.rectangle([x, 445, x + w, 575], fill="black")
        x += w + rng.choice([2, 3, 4])
    d.text((26, 590), "TRACKING #", fill="black", font=_font(20))
    d.text((26, 618), label["tracking"], fill="black", font=_font(44))
    d.line([8, 685, W - 8, 685], fill="black", width=3)
    d.text((26, 700), "CONTENTS: " + label["declared_contents"], fill="black", font=_font(20, False))
    d.text((26, 728), "WEIGHT: " + label["weight"], fill="black", font=_font(20, False))
    x = 26
    for mark in label["marks"]:
        if mark == "NONE":
            continue
        text = mark.replace("_", " ")
        tw = d.textlength(text, font=_font(20)) + 24
        fill = (220, 30, 40) if mark in ("FRAGILE", "LITHIUM_BATTERY") else (20, 20, 20)
        d.rectangle([x, 780, x + tw, 830], fill=fill)
        d.text((x + 12, 793), text, fill="white", font=_font(20))
        x += tw + 12
    if label.get("smudged"):
        # a wet thumb across the ZIP and part of the tracking number
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        # opaque in the middle: the digits under it are really gone, so an honest reader writes UNREADABLE
        # and the tool gate blocks the claim (packet_unreadable) on stage
        ld.ellipse([56, 326, 304, 434], fill=(62, 52, 42, 255))
        ld.ellipse([176, 596, 424, 684], fill=(70, 60, 50, 255))
        layer = layer.filter(ImageFilter.GaussianBlur(6))
        img.paste(layer, (0, 0), layer)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _norm(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def judge(label: dict, packet: dict) -> dict:
    """Grade a ClaimPacket against the hidden key. All three must match."""
    tracking_ok = _norm(packet.get("tracking", "")) == _norm(label["tracking"])
    zip_ok = _norm(packet.get("consignee_zip", "")) == _norm(label["zip"])
    want = {m for m in label["marks"] if m != "NONE"}
    got = {_norm(m).replace("THISSIDEUP", "THIS_SIDE_UP").replace("LITHIUMBATTERY", "LITHIUM_BATTERY")
           .replace("KEEPDRY", "KEEP_DRY") for m in packet.get("marks", []) if _norm(m) not in ("", "NONE")}
    marks_ok = want == got
    correct = tracking_ok and zip_ok and marks_ok
    return {"correct": correct, "tracking_ok": tracking_ok, "zip_ok": zip_ok, "marks_ok": marks_ok,
            "label_index": label["index"], "expected": {"tracking": label["tracking"], "zip": label["zip"],
                                                         "marks": sorted(want)}}
