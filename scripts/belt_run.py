"""Headless belt run in the terminal. Shows Jev and Gemini events interleaved, with timestamps.

  uv run python scripts/belt_run.py                 # Workflow sorts (Jev + Gemini), all parcels
  uv run python scripts/belt_run.py --mode h2h      # Jev vs Gemini, same parcel, same question
  uv run python scripts/belt_run.py --limit 12 --adk  # also print every raw ADK event
  uv run python scripts/belt_run.py --calls         # also print the call log (every Jev + Gemini call)
"""
import argparse
import asyncio
import json
import sys
import textwrap
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from belt import calls  # noqa: E402
from belt.run import run_workflow  # noqa: E402

LANE = {"jev": "JEV   ", "gem": "GEMINI", "adk": "adk   ", "belt": "belt  "}


def printer(show_adk: bool):
    def emit(e: dict) -> None:
        t, k = f"[{e['t']:7.3f}s]", e["type"]
        if k == "decision":
            d = e["decision"]
            print(f"{t} {LANE['jev']} tick {e['id']}  {d['action']:<10} conf {d['confidence']:.2f}  "
                  f"damaged {d['damaged']:.2f}  {e['ms']:>4} ms{'  REPLAY' if e['replay'] else ''}  -> {e['outcome']}"
                  f"{'   << CLAIM FILED' if e['claim_used'] else ''}")
        elif k == "gemini_start":
            print(f"{t} {LANE['gem']} claims_clerk starts reading label #{e['label_index']}"
                  f"{' (smudged on purpose)' if e['smudged'] else ''}")
        elif k == "claim":
            g = e["graded"]
            print(f"{t} {LANE['gem']} claim packet after {e['took']} s: tracking={e['packet'].get('tracking')!r} "
                  f"zip={e['packet'].get('consignee_zip')!r} marks={e['packet'].get('marks')} -> "
                  f"{'CORRECT, claim ready' if e['ok'] else 'WRONG'}{' -> retry' if e['retry'] else ''}")
        elif k == "check":
            if not e["ready"] and e["waited"] is not None:
                print(f"{t} {LANE['belt']}   check_claim: not ready, Gemini reading {e['waited']} s - belt keeps going")
        elif k == "summary_start":
            print(f"{t} {LANE['gem']} shift_lead starts the end-of-shift report")
        elif k == "run_start":
            print(f"{t} {LANE['belt']} START mode={e['mode']} parcels={e['parcels']} jev={e['jev_model']} "
                  f"gemini={e['gemini_model']} replay={e['replay']}")
        elif k == "run_end":
            print(f"{t} {LANE['belt']} END scorecard {json.dumps(e['score'])}")
            if e.get("report"):
                print(f"{' ' * 19}{e['report'].get('headline', '')}")
                for line in textwrap.wrap(e["report"].get("report", ""), 90):
                    print(" " * 19 + line)
        elif k == "adk" and e.get("thought"):
            print(f"{t} {LANE['gem']} {e['author']} thinking: {e['thought'].strip()[:110]!r}")
        elif k == "adk" and show_adk:
            extra = f" text+={e['text']!r}" if e.get("text") else ""
            print(f"{t} {LANE['adk']} author={e['author']} node={e['node']} partial={e['partial']} "
                  f"keys={e['keys']}{extra[:80]}")
        sys.stdout.flush()
    return emit


def stream_printer(show_nodes: bool):
    """The API contract events (GET /api/stream): lanes, skips, Gemini calls, the guard."""
    def out(e: dict) -> None:
        t, k = f"[{e['t']:7.3f}s]", e["type"]
        if k == "route":
            print(f"{t} FLOOR  route {e['parcel_id']} -> {e['lane'].upper():<6} {e['reason']}")
        elif k == "gemini_skipped":
            print(f"{t} FLOOR  gemini_skipped {e['parcel_id']} ({e['lane']}) saved ~{e['saved_ms_est']} ms "
                  f"${e['saved_cost_est']:.5f} [{e['basis']}]")
        elif k == "llm_start":
            print(f"{t} GEMINI {e['agent']} starts {e.get('parcel_id') or ''} ({e['call_id']})")
        elif k == "llm_end":
            o = json.dumps(e["output"])[:110]
            print(f"{t} GEMINI {e['agent']} done {e.get('parcel_id') or ''} {e['ms']} ms in={e['tokens_in']} "
                  f"out={e['tokens_out']} ${e['cost']:.5f} {'LIVE' if e['live'] else 'REPLAY'} -> {o}")
        elif k == "tool_proposed":
            print(f"{t} GEMINI claims_clerk proposes {e['tool']}({json.dumps(e['args'])[:120]})")
        elif k == "guard_verdict":
            print(f"{t} GUARD  {'ALLOWED' if e['allowed'] else 'BLOCKED'} {e['tool']} {e.get('parcel_id')} rule={e['rule']}")
        elif k == "decision" and e["decided_by"] != "jev":
            print(f"{t} FLOOR  decision {e['parcel_id']} = {e['final_action']} by {e['decided_by']}")
        elif k == "human_queue":
            print(f"{t} HUMAN  queued {e['parcel_id']}: {e['reason']}")
        elif k == "h2h_result":
            j, g = e["jev"], e["gemini"]
            print(f"{t} H2H    {e['parcel_id']} key={e['truth']:<6} Jev {str(j.get('action')):<6} {j.get('outcome')!s:<9} "
                  f"{j.get('ms')} ms | Gemini {str(g.get('action')):<6} {g.get('outcome')!s:<9} {g.get('ms')} ms "
                  f"{'agree' if e['agree'] else 'DIFFER'}")
        elif k == "run_end" and "agreement_rate" in e["scorecard"]:
            sc = e["scorecard"]
            for side in ("jev", "gemini"):
                st = sc[side]
                print(f"{t} H2H    {side:<6} correct {st['correct']}/{st['parcels']} near-miss {st['near_miss']} "
                      f"mean {st['ms_mean']} ms p95 {st['ms_p95']} ms ${st['cost_per_1k']}/1k parcels")
            print(f"{t} H2H    agree {sc['agree']}/{sc['both_answered']} · Gemini as the reflex: {sc['gemini_wait_s']} s per parcel")
        elif k == "run_end":
            sc = e["scorecard"]
            print(f"{t} STATS  lanes={sc['lanes']} skipped={sc['gemini_skipped']} gemini_calls={sc['gemini_calls']} "
                  f"gemini_cost=${sc['gemini_cost']:.5f} jev_cost=${sc['jev_cost']:.5f} blocked={sc['blocked_tools']} "
                  f"allowed={sc['allowed_tools']} claims={sc['claims_filed']} human_pending={sc['human_pending']}")
        elif k == "adk_node" and show_nodes:
            print(f"{t} adk    {e['node']} {e['phase']}")
        sys.stdout.flush()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="workflow", choices=["workflow", "h2h"],
                    help="workflow = Jev + Gemini + floor manager; h2h = Jev vs Gemini, same parcel, same question")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--adk", action="store_true", help="print raw ADK events too")
    ap.add_argument("--calls", action="store_true", help="print the call log too")
    ap.add_argument("--pace", type=float, help="seconds between parcels (default BELT_TICK_SECONDS)")
    ap.add_argument("--set", help="named parcel set from belt/sets.py, e.g. r3")
    a = ap.parse_args()
    if a.calls:
        def log_call(e: dict) -> None:
            if e.get("status") != "pending" and "decision" not in e:   # once per call, when it returns
                print(f"{'':11}CALL   {e['id']} {e.get('model')} {'LIVE' if e.get('live') else 'REPLAY'} "
                      f"{e.get('ms')} ms in={e.get('input_tokens')} out={e.get('output_tokens')} {e.get('purpose')} "
                      f"{e.get('parcel') or ''}")
        calls.LISTENERS.append(log_call)
    from belt import sets
    chosen = sets.resolve(a.set) if a.set else None
    asyncio.run(run_workflow(a.mode, printer(a.adk), a.limit, a.pace, stream=stream_printer(a.adk), parcels=chosen))


main()
