# The belt never stops

Demo code for the talk **"Make your AI agent think fast and slow"** (DevFest Montréal 2026).

A parcel-sorting belt run as a Google ADK workflow. Each parcel needs a decision in under a second:

- **Jev** (TypeSafe System One) makes the fast call and returns calibrated probabilities.
- **Gemini** takes a second look only when Jev is unsure, and does the slow work: reading labels, writing reports, proposing policy edits.
- **Code** (`belt/floor.py`) decides who acts, based on the confidence number.

## Three rounds

| Round | URL | What it shows |
|---|---|---|
| 1 · You sort | `/?mode=you&limit=8&sec=2` | You sort parcels by hand, 2 s each, then compare with Jev |
| 2 · Head to head | `/?mode=h2h&limit=10&pace=1&calib=1` | Jev vs Gemini (and optionally Gemma 4 12B): same photo, same question, same moment |
| 3 · The team | `/?mode=workflow&set=r3&pace=1` | Jev + Gemini + code rules as one ADK workflow, with a human desk |

## Run it

Requires Python 3.12, [uv](https://docs.astral.sh/uv/), Node 20+ and the gcloud CLI.

```bash
cp .env.example .env              # add your TYPESAFE_API_KEY and GOOGLE_CLOUD_PROJECT
gcloud auth application-default login
uv sync
(cd web && npm ci && npm run build)
scripts/belt.sh                   # http://127.0.0.1:8095
```

Run it headless from the command line: `uv run python scripts/belt_run.py --set r3 --pace 1`
Run the tests: `uv run pytest -q`

With no API key, recorded answers in `belt/replay.json` are used, and the page shows a REPLAY badge.

## Optional: Gemma 4 12B on Cloud Run (one L4 GPU)

vLLM v0.33.0 serves Gemma 4 on the same `/v1/systemone` API, images included.

```bash
gcloud run deploy gemma4-systemone --image docker.io/vllm/vllm-openai:v0.33.0 \
  --region us-east4 --gpu 1 --gpu-type nvidia-l4 --no-gpu-zonal-redundancy \
  --cpu 8 --memory 32Gi --port 8000 --no-allow-unauthenticated --min-instances 0 --max-instances 1 \
  '--args=^|^google/gemma-4-12B-it-qat-w4a16-ct|--served-model-name=gemma-4-12b|--max-model-len=8192|--gpu-memory-utilization=0.90|--logprobs-mode=raw_logprobs|--limit-mm-per-prompt={"image":1,"audio":0,"video":0}|--host=0.0.0.0|--port=8000'
```

Then set `BELT_GEMMA_URL=<service URL>` in `.env`. Round 2 then shows a third card for Gemma.

- Cost: about $1.42 per hour while an instance is up.
- A cold start takes several minutes. Set `--min-instances 1` before a demo.
- See also the [vLLM recipe](https://recipes.vllm.ai/Google/gemma-4-12B-it).

## Layout

| Path | What |
|---|---|
| `belt/workflow.py` | Round 3: the ADK workflow (Jev, Gemini agents, the floor manager) |
| `belt/h2h.py` | Round 2: the head-to-head |
| `belt/floor.py` | The gate: auto / second look / human |
| `belt/jev.py`, `belt/reflex.py` | Jev calls and the questions it gets |
| `belt/gemma.py` | Gemma 4 on vLLM `/v1/systemone` |
| `belt/server.py` | FastAPI server + event stream |
| `web/` | The React front end |
| `photos/real/` | 30 parcel photos with an answer key (`manifest.json`, with credits) |

## Photos

Reused under their licences (Pexels, Unsplash, Wikimedia Commons). Credits are in `photos/real/manifest.json`.
