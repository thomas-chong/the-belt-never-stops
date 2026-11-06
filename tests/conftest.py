"""Tests never call the self-hosted Gemma GPU (belt/gemma.py); mode 2 runs two sides here."""
import os

os.environ["BELT_GEMMA"] = "0"
