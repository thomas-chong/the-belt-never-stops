"""Synthetic placeholder parcel photos, drawn with Pillow.

Real box photos do not exist yet. Until they do, this draws ~30 clearly
marked stand-ins (each says SYNTHETIC PLACEHOLDER in a corner) so every rule
in choose() can be rehearsed. The category is never written on the picture;
it lives only in the hidden answer key in belt/manifest.json.

Run:  uv run python -m belt.photos          (writes photos/placeholder/ + belt/manifest.json)
Replace with real photos: see README "Real photos".
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "photos" / "placeholder"
MANIFEST = ROOT / "belt" / "manifest.json"
W, H = 768, 576

# kind -> hidden truth. action is what a careful person would do.
TRUTH = {
    "clean":     {"action": "ship",   "risk": 0, "damaged": False},
    "open_tape": {"action": "retape", "risk": 1, "damaged": False},
    "dented":    {"action": "ship",   "risk": 1, "damaged": False},
    "crushed":   {"action": "hold",   "risk": 2, "damaged": True},
    "torn":      {"action": "hold",   "risk": 2, "damaged": True},
    "wet":       {"action": "hold",   "risk": 2, "damaged": True},
    "leaking":   {"action": "return", "risk": 2, "damaged": True},
    "ambiguous": {"action": "ship",   "risk": 0, "damaged": False},   # intact box in shadow: hold is "safe"
    "fragile":   {"action": "ship",   "risk": 0, "damaged": False},
}

DECLARED = {
    "clean": ["Paperback books, 3", "Cotton T-shirts", "Board game", "Running shoes", "Desk lamp, boxed",
              "Yoga mat", "Coffee beans, 1 kg"],
    "open_tape": ["Kitchen towels", "Phone case", "Wool socks"],
    "dented": ["Plastic storage bins", "Hoodie", "Notebook set"],
    "crushed": ["Ceramic mugs, set of 4", "Glass vase", "Bluetooth speaker"],
    "torn": ["Picture frame, glass front", "Wine glasses, 2"],
    "wet": ["Hardcover books", "Printer paper, 5 reams"],
    "leaking": ["Olive oil, 2 bottles", "Liquid laundry soap"],
    "ambiguous": ["Desk monitor, 27 inch", "Mixed groceries"],
    "fragile": ["Ceramic plates, 6", "Glass candle jars"],
}

# The running order on the belt. Fixed, so rehearsals match the show.
ORDER = (["clean", "clean", "dented", "clean", "crushed", "open_tape", "clean", "fragile", "torn",
          "clean", "ambiguous", "wet", "clean", "dented", "leaking", "clean", "open_tape", "crushed",
          "clean", "fragile", "clean", "ambiguous", "dented", "clean", "torn", "clean", "open_tape",
          "crushed", "clean", "wet"])

KRAFT = (196, 154, 108)
KRAFT_DARK = (150, 112, 74)
KRAFT_TOP = (214, 176, 130)
TAPE = (222, 200, 160)


def _font(size: int):
    for name in ("DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _belt(d: ImageDraw.ImageDraw, rng: random.Random) -> None:
    shade = rng.randint(54, 70)
    d.rectangle([0, 0, W, H], fill=(shade, shade + 4, shade + 10))
    d.rectangle([0, 380, W, H], fill=(38, 40, 44))
    for x in range(-40, W + 40, 64):
        d.line([x, 380, x + 20, H], fill=(30, 31, 34), width=6)
    d.rectangle([0, 372, W, 384], fill=(90, 94, 100))


def _box(img: Image.Image, rng: random.Random, kind: str) -> tuple[list, dict]:
    d = ImageDraw.Draw(img)
    cx = rng.randint(330, 430)
    bw, bh, depth = rng.randint(260, 320), rng.randint(170, 210), rng.randint(60, 90)
    x0, y1 = cx - bw // 2, 430
    y0 = y1 - bh
    front = [(x0, y0), (x0 + bw, y0), (x0 + bw, y1), (x0, y1)]
    top = [(x0, y0), (x0 + depth, y0 - depth * 0.6), (x0 + bw + depth, y0 - depth * 0.6), (x0 + bw, y0)]
    side = [(x0 + bw, y0), (x0 + bw + depth, y0 - depth * 0.6), (x0 + bw + depth, y1 - depth * 0.6), (x0 + bw, y1)]
    if kind == "crushed":
        sag = rng.randint(55, 80)
        front = [(x0, y0 + 25), (x0 + bw * 0.45, y0 + sag), (x0 + bw, y0 + 10), (x0 + bw - 8, y1), (x0 + 6, y1)]
        top = [(x0, y0 + 25), (x0 + depth, y0 - depth * 0.6 + 30), (x0 + bw + depth, y0 - depth * 0.6),
               (x0 + bw, y0 + 10), (x0 + bw * 0.45, y0 + sag)]
    # shadow
    d.ellipse([x0 - 20, y1 - 18, x0 + bw + depth + 30, y1 + 26], fill=(28, 28, 30))
    d.polygon(side, fill=KRAFT_DARK)
    d.polygon(top, fill=KRAFT_TOP)
    d.polygon(front, fill=KRAFT)
    for poly in (front, top, side):
        d.line(poly + [poly[0]], fill=(110, 80, 50), width=3)
    region = {"x0": x0, "y0": int(y0 - depth * 0.6), "x1": int(x0 + bw + depth), "y1": y1, "bw": bw, "bh": bh,
              "depth": depth}
    # tape strip along the top
    if kind != "open_tape":
        tx = x0 + bw // 2
        d.polygon([(tx - 18, y0), (tx + 18, y0), (tx + 18 + depth, y0 - depth * 0.6), (tx - 18 + depth, y0 - depth * 0.6)],
                  fill=TAPE)
        d.rectangle([tx - 18, y0, tx + 18, y0 + 40], fill=TAPE)
    return front, region


def _damage(img: Image.Image, rng: random.Random, kind: str, r: dict) -> dict | None:
    """Draw the damage. Returns the damaged area as fractions (for the README), or None."""
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1, bw, bh = r["x0"], r["y0"], r["x1"], r["y1"], r["bw"], r["bh"]
    fy0 = y1 - bh
    area = None
    if kind == "open_tape":
        tx = x0 + bw // 2
        d.polygon([(tx - 18, fy0), (tx + 18, fy0), (tx + 60, fy0 - 90), (tx + 30, fy0 - 100)], fill=TAPE)
        d.line([(tx - 18, fy0), (tx + 30, fy0 - 100)], fill=(150, 130, 90), width=2)
        d.polygon([(x0 + 20, fy0), (x0 + bw // 2 - 4, fy0), (x0 + bw // 2 - 30, fy0 - 50), (x0 + 30, fy0 - 40)],
                  fill=KRAFT_TOP, outline=(110, 80, 50))
        d.rectangle([x0 + bw // 2 - 2, fy0 - 2, x0 + bw // 2 + 2, fy0 + 6], fill=(30, 20, 10))
        area = (x0 + 10, fy0 - 110, x0 + bw // 2 + 70, fy0 + 10)
    elif kind == "dented":
        cx, cy = x0 + bw - 40, fy0 + 40
        for i in range(5):
            d.arc([cx - 40 + i * 4, cy - 30 + i * 3, cx + 30 - i * 4, cy + 30 - i * 3], 100, 260,
                  fill=(130, 95, 60), width=3)
        d.line([(x0 + bw - 60, fy0), (x0 + bw, fy0 + 70)], fill=(120, 88, 56), width=3)
        for _ in range(6):
            sx = rng.randint(x0 + 20, x0 + bw - 20)
            sy = rng.randint(fy0 + 60, y1 - 20)
            d.line([(sx, sy), (sx + rng.randint(10, 30), sy + rng.randint(-4, 4))], fill=(170, 135, 95), width=2)
        area = (cx - 50, fy0 - 5, x0 + bw + 5, cy + 45)
    elif kind == "crushed":
        for _ in range(7):
            sx = rng.randint(x0 + 10, x0 + bw - 10)
            d.line([(sx, fy0 + rng.randint(20, 60)), (sx + rng.randint(-40, 40), y1 - rng.randint(5, 40))],
                   fill=(95, 66, 40), width=4)
        d.polygon([(x0 + bw * 0.3, fy0 + 40), (x0 + bw * 0.6, fy0 + 70), (x0 + bw * 0.5, fy0 + 110)],
                  fill=(60, 40, 24))
        d.line([(x0 + bw * 0.45, fy0 + 70), (x0 + bw * 0.55, y1)], fill=(80, 55, 32), width=6)
        area = (x0, fy0 - 10, x0 + bw, y1)
    elif kind == "torn":
        hx, hy = x0 + rng.randint(60, bw - 120), fy0 + rng.randint(40, bh - 90)
        pts = []
        for i in range(14):
            ang = i / 14 * math.tau
            rad = rng.randint(28, 52)
            pts.append((hx + 45 + rad * math.cos(ang), hy + 35 + rad * 0.8 * math.sin(ang)))
        d.polygon(pts, fill=(25, 18, 12))
        for p in pts[::2]:
            d.line([p, (p[0] + rng.randint(-14, 14), p[1] + rng.randint(-14, 14))], fill=(230, 210, 180), width=3)
        d.rectangle([hx + 30, hy + 25, hx + 60, hy + 45], fill=(235, 235, 240))
        area = (hx - 15, hy - 25, hx + 105, hy + 95)
    elif kind == "wet":
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        cx, cy = x0 + rng.randint(80, bw - 80), fy0 + rng.randint(50, bh - 50)
        for i in range(30):
            rr = rng.randint(20, 70)
            ox, oy = rng.randint(-60, 60), rng.randint(-40, 60)
            ld.ellipse([cx + ox - rr, cy + oy - rr, cx + ox + rr, cy + oy + rr], fill=(70, 45, 25, 60))
        layer = layer.filter(ImageFilter.GaussianBlur(6))
        img.paste(layer, (0, 0), layer)
        d = ImageDraw.Draw(img)
        for _ in range(5):
            sx = cx + rng.randint(-50, 50)
            d.line([(sx, cy + 40), (sx + rng.randint(-5, 5), y1)], fill=(90, 60, 35), width=5)
        area = (cx - 130, cy - 110, cx + 130, y1)
    elif kind == "leaking":
        d.ellipse([x0 - 60, y1 - 10, x0 + bw + 40, y1 + 70], fill=(150, 125, 30))
        d.ellipse([x0 - 20, y1 + 5, x0 + bw - 40, y1 + 55], fill=(185, 160, 50))
        for _ in range(6):
            sx = rng.randint(x0 + 20, x0 + bw - 20)
            d.line([(sx, y1 - 90), (sx, y1)], fill=(160, 135, 40), width=7)
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).rectangle([x0, y1 - 110, x0 + bw, y1], fill=(90, 70, 20, 110))
        img.paste(layer, (0, 0), layer)
        d = ImageDraw.Draw(img)
        d.polygon([(x0 + bw * 0.4, fy0 + 20), (x0 + bw * 0.6, fy0 + 40), (x0 + bw * 0.5, fy0 + 80)], fill=(40, 28, 16))
        area = (x0 - 60, y1 - 120, x0 + bw + 40, min(H, y1 + 70))
    elif kind == "ambiguous":
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.polygon([(0, 0), (W * 0.75, 0), (W * 0.45, H), (0, H)], fill=(0, 0, 0, 170))
        layer = layer.filter(ImageFilter.GaussianBlur(25))
        img.paste(layer, (0, 0), layer)
        d = ImageDraw.Draw(img)
        lx, ly = x0 + bw - 110, fy0 + 50
        d.ellipse([lx, ly, lx + 70, ly + 60], fill=(55, 38, 28))
        d.text((lx + 12, ly + 18), "ACME", fill=(80, 60, 45), font=_font(16))
    return None if area is None else {"left": round(area[0] / W, 3), "top": round(area[1] / H, 3),
                                      "right": round(area[2] / W, 3), "bottom": round(area[3] / H, 3)}


def _fragile_sticker(img: Image.Image, r: dict) -> None:
    d = ImageDraw.Draw(img)
    fx, fy = r["x0"] + 24, r["y1"] - r["bh"] + 60
    d.rectangle([fx, fy, fx + 150, fy + 70], fill=(220, 30, 40), outline=(255, 255, 255), width=3)
    d.text((fx + 14, fy + 10), "FRAGILE", fill="white", font=_font(26))
    d.text((fx + 14, fy + 42), "HANDLE WITH CARE", fill="white", font=_font(11))


def _battery_sticker(img: Image.Image, r: dict) -> None:
    """A lithium-battery handling label (class 9 style: white with black stripes, battery icon)."""
    d = ImageDraw.Draw(img)
    fx, fy = r["x0"] + r["bw"] - 190, r["y1"] - r["bh"] + 40
    d.rectangle([fx, fy, fx + 170, fy + 120], fill=(250, 250, 250), outline=(220, 30, 40), width=6)
    for i in range(5):
        d.polygon([(fx + 10 + i * 14, fy + 10), (fx + 18 + i * 14, fy + 10), (fx + 8 + i * 14, fy + 50),
                   (fx + i * 14, fy + 50)], fill=(20, 20, 20))
    d.rectangle([fx + 92, fy + 18, fx + 150, fy + 46], outline=(20, 20, 20), width=4)
    d.rectangle([fx + 150, fy + 26, fx + 158, fy + 38], fill=(20, 20, 20))
    d.text((fx + 12, fy + 60), "LITHIUM ION", fill=(20, 20, 20), font=_font(18))
    d.text((fx + 12, fy + 84), "BATTERY", fill=(220, 30, 40), font=_font(22))


def draw(pid: str, kind: str, seed: int) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", (W, H))
    _belt(ImageDraw.Draw(img), rng)
    _, region = _box(img, rng, kind)
    area = _damage(img, rng, kind, region)
    if kind == "fragile":
        _fragile_sticker(img, region)
    if kind == "battery":
        _battery_sticker(img, region)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 26], fill=(20, 20, 24))
    d.text((10, 5), f"SYNTHETIC PLACEHOLDER  {pid}  replace with a real photo", fill=(255, 210, 60), font=_font(14))
    img.info["area"] = area
    return img.filter(ImageFilter.GaussianBlur(0.6))


def build(out: Path = OUT, manifest: Path = MANIFEST) -> list[dict]:
    out.mkdir(parents=True, exist_ok=True)
    parcels = []
    used: dict[str, int] = {}
    for i, kind in enumerate(ORDER):
        pid = f"P-{101 + i:04d}"
        n = used.get(kind, 0)
        used[kind] = n + 1
        declared = DECLARED[kind][n % len(DECLARED[kind])]
        img = draw(pid, kind, seed=1000 + i)
        path = out / f"{pid}.jpg"
        img.save(path, "JPEG", quality=85)
        parcels.append({"id": pid, "file": str(path.relative_to(ROOT)), "declared": declared,
                        "kind": kind, "fragile_sticker": kind == "fragile", "truth": TRUTH[kind]})
    manifest.write_text(json.dumps({"source": "synthetic placeholder (belt/photos.py)", "parcels": parcels},
                                   indent=1))
    return parcels


# Extra stand-ins for the "why not YOLO?" moments (context test, policy editor). Not on the belt.
DEMO = {"DEMO-BATTERY": ("battery", 11, "Power bank 20000 mAh"), "DEMO-DENTED": ("dented", 12, "Plastic storage bins")}


def build_demo(out: Path = OUT) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    for pid, (kind, seed, _declared) in DEMO.items():
        draw(pid, kind, seed).save(out / f"{pid}.jpg", "JPEG", quality=85)
    return list(DEMO)


if __name__ == "__main__":
    build_demo()
    ps = build()
    print(f"wrote {len(ps)} placeholder photos to {OUT} and {MANIFEST}")
