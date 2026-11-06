"""The sorting policy: the text of each option Jev is asked to choose between.

The policy is words, not weights. Change a description, press Apply, and the very next
Jev call uses it: no training images, no retraining. The thresholds that turn Jev's
answer into an action (TRUST_CONFIDENCE 0.40, AUTO_SHIP 0.80, ...) stay in code, in
belt/reflex.py.
"""

from __future__ import annotations

import threading
import time

from belt import reflex

OPTIONS = ("ship", "retape", "hold", "return", "file_claim")
DEFAULT = {**reflex.RESPONSES, "file_claim": reflex.CLAIM}
MAX_LEN = 400

PRESETS: dict[str, dict] = {
    "standard": {"name": "Standard rules", "options": dict(DEFAULT)},
    "peak": {
        "name": "Peak season: small dents ship with retape",
        "options": {
            **DEFAULT,
            "ship": "The box is intact and closed, with no dents at all. Send it on.",
            "retape": "Peak season: the box has small dents or scuffs, or the tape or a flap is open, "
                      "but it is not crushed, torn or wet. Retape it and send it on.",
        },
    },
    "hazmat": {
        "name": "New rule: battery sticker -> hold for hazmat check",
        "options": {
            **DEFAULT,
            "ship": DEFAULT["ship"].replace("Send it on.", "No lithium battery or hazmat sticker. Send it on."),
            "hold": "The box is crushed, torn, punctured or wet, or dented with fragile contents, OR it has a "
                    "lithium battery or hazmat sticker on it: hold it for a hazmat check.",
        },
    },
}

_lock = threading.Lock()
STATE: dict = {}


def reset() -> None:
    with _lock:
        STATE.clear()
        STATE.update(options=dict(DEFAULT), name=PRESETS["standard"]["name"], preset="standard", version=1,
                     applied_at=None, first_decision_s=None, history=[])


reset()


def current_options() -> dict[str, str]:
    return dict(STATE["options"])


def version() -> int:
    return STATE["version"]


def validate(options: dict) -> dict[str, str]:
    if not isinstance(options, dict):
        raise ValueError("options must be an object")
    out = {}
    for key in OPTIONS:
        text = options.get(key, STATE["options"][key])
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"option '{key}' needs a description")
        if len(text) > MAX_LEN:
            raise ValueError(f"option '{key}' is longer than {MAX_LEN} characters")
        out[key] = " ".join(text.split())
    unknown = set(options) - set(OPTIONS)
    if unknown:
        raise ValueError(f"unknown options: {sorted(unknown)} (the option set is fixed; only the words change)")
    return out


def apply(options: dict | None = None, preset: str | None = None, name: str | None = None) -> dict:
    """Swap the policy. Returns the public state. Raises ValueError on bad input."""
    if preset:
        if preset not in PRESETS:
            raise ValueError(f"unknown preset '{preset}'")
        options = PRESETS[preset]["options"]
        name = name or PRESETS[preset]["name"]
    new = validate(options or {})
    with _lock:
        STATE["history"].append({"version": STATE["version"], "name": STATE["name"]})
        STATE.update(options=new, name=name or "Edited by hand", preset=preset or "custom",
                     version=STATE["version"] + 1, applied_at=time.time(), first_decision_s=None)
    return public()


def note_decision(policy_version: int, finished_at: float) -> None:
    """The first Jev answer under a new policy: 'rule changed in X s' on the page."""
    with _lock:
        if (policy_version == STATE["version"] and STATE["applied_at"] is not None
                and STATE["first_decision_s"] is None):
            STATE["first_decision_s"] = round(finished_at - STATE["applied_at"], 2)


def public() -> dict:
    return {
        "options": dict(STATE["options"]), "name": STATE["name"], "preset": STATE["preset"],
        "version": STATE["version"], "applied_at": STATE["applied_at"], "first_decision_s": STATE["first_decision_s"],
        "default": dict(DEFAULT), "changed": [k for k in OPTIONS if STATE["options"][k] != DEFAULT[k]],
        "presets": {k: {"name": v["name"], "options": v["options"]} for k, v in PRESETS.items()},
        "training_images": 0, "retraining": "none",
        "thresholds": {"TRUST_CONFIDENCE": reflex.TRUST_CONFIDENCE, "AUTO_SHIP": reflex.AUTO_SHIP,
                       "SEVERE_RISK": reflex.SEVERE_RISK, "CLAIM_ON_DAMAGE": reflex.CLAIM_ON_DAMAGE},
    }
