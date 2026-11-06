"""Load .env (if any) and default to Gemini on Vertex AI. Never prints secrets."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(path: Path = ROOT / ".env") -> None:
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "1")
    os.environ.setdefault("GOOGLE_CLOUD_LOCATION", "global")
    os.environ.setdefault("ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS", "1")


load()
