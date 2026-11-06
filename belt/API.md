# Belt API (backend contract for the `web/` front end)

Server: `uv run python -m belt.server [--host 127.0.0.1] [--port 8095]` (FastAPI). `/` serves `web/dist/index.html`
when it exists (checked on every request, so a fresh `npm run build` needs no restart), else the original page in
`belt/static`. The original page is always at `/legacy` and keeps its own stream, `GET /api/events`.

Roles: **Jev** = reflex (decides every parcel, calibrated confidence). **Gemini** = clerk + teacher
(`second_look`, `claims_clerk`, `shift_lead`, `teacher`). **ADK** = floor manager (graph `belt` in
`belt/workflow.py`, rules in `belt/floor.py`, teacher graph `teach` in `belt/teach.py`).

Modes (`POST /api/run`): **`workflow`** (mode 3 on the page: Jev + Gemini + the floor manager, graph `belt`)
and **`h2h`** (mode 2: "Jev vs Gemini, same parcel, same question", graph `belt_head_to_head` in
`belt/h2h.py`). Mode 1 (You sort, `/?mode=you`, its own screen) runs in the page with `/api/manifest` +
`/api/judge`, and compares the person with Jev at the end with `POST /api/you/jev`. There is no webcam mode and
no Jev-only "model" mode any more.

**Safety gate (mode 3).** The `gate` node no longer uses one confidence threshold. `floor.gate_route()` runs
every check below on each parcel; the most cautious lane any fired check asks for wins (human > gemini > auto)
and `rule` names the first check that asked for it. All plain code, unit-tested (`tests/test_safety.py`).

| rule | lane | fires when |
|---|---|---|
| `abstain_low_confidence` | human | confidence < abstain (0.40) |
| `return_never_auto` | gemini | Jev picks return / file_claim / issue_refund: irreversible or money, never alone |
| `cross_check_disagree` | gemini | Jev picks ship/retape but P(damaged) >= 0.50 or risk >= 1.20 (its own answers disagree) |
| `marks_vs_declared` | human | FRAGILE mark on the box (handling) but declared contents not fragile, and Jev picks ship/retape |
| `fragile_no_auto_ship` | gemini | tier fragile (declared glass/ceramic/... or a FRAGILE mark) and Jev picks ship |
| `drift_paused` | gemini | the drift alarm paused auto-ship / auto-retape |
| `below_<action>_bar` | gemini | confidence < the bar for Jev's action (+0.05 high-value tier for ship/retape, +0.10 fragile tier for retape, + the drift offset for ship/retape) |
| `auto_<action>` | auto | nothing above fired: Jev decides alone |

Bars: **ship 0.90, retape 0.85, hold 0.50** (hold is the safe action: a person looks), return never; loaded
from `belt/calibration.json` (`scripts/calibrate_gate.py`) when it exists, else the design values. The old
single-threshold gate (0.80 / 0.40, `floor.lane_for`) is kept only for the comparison: every `route` carries
`legacy_lane`. **Audit:** a share `audit_rate` (default 0.10, env `BELT_AUDIT_RATE`) of auto-lane parcels, picked by
a hash of (run seed, parcel id), also gets a real `second_look` in shadow (the decision stands, the belt does not
wait). Gemini disagreeing (or asking for a person) flags it and puts it on the human desk as `kind: "audit"`.
The audit label is the person's answer when they give one, else the answer key (a stand-in for the human
auditor; said so in `label_source`). **Drift:** when confirmed audit mistakes > alpha x audits (alpha 0.02,
env `BELT_ALPHA`), the gate tightens (ship / retape bars +0.05); a second breach pauses auto-ship and
auto-retape. It never relaxes by itself (`POST /api/safety {reset_drift: true}`). Reset at the start of each run.

**Gemini model:** one value for every Gemini agent (`second_look`, `claims_clerk`, `shift_lead`, `teacher`,
`gemini_reflex`): env `BELT_GEMINI_MODEL`, default **`gemini-3.5-flash-lite`** (Vertex AI, location `global`).
`GET /api/health` returns it with the price in use.

**Gemini jobs.** Every `llm_start` / `llm_end` carries `job` (and `llm_start` a `job_label`):

| agent | job | job_label |
|---|---|---|
| `second_look` | `decision` | 2nd look (decision on unsure parcels) |
| `gemini_reflex` | `decision` | reflex (decision on every parcel, head-to-head) |
| `claims_clerk` | `clerk` | clerk (reads label -> claim) |
| `shift_lead` | `report` | report |
| `teacher` | `teacher` | teacher |

Only `decision` calls make the same kind of decision Jev makes, so only they are compared with Jev's
decision latency or cost.

## SSE `GET /api/stream`

`data: {json}` lines. Every event has `type` and `ts` (Unix seconds, ms precision). Events emitted during a
run also carry `t` (seconds since the run started). Field lists below are the contract fields first, then
extras (marked +).

| type | fields |
|---|---|
| `run_start` | + `mode`, `total`, `jev_model`, `gemini_model`, `replay_jev`, `replay_gemini`, `pace`, `thresholds`, `policy_version`, `policy_name`, `desks`, `safety` {effective, source, audit_rate, alpha, legacy, seed} |
| `parcel` | `parcel_id`, `photo_url` (`/api/photos/P-0101.jpg`), `declared`, `index` (1-based), `total`; + `credit` |
| `jev_call` | `call_id`, `parcel_id`, `ms`, `tokens_in`, `tokens_out`, `cost` (USD, 0 in replay), `live`, `probabilities`, `confidence`, `action` (the code's action from `choose()` under the current thresholds); + `model_choice` (Jev's raw pick), `why`, `damaged`, `risk`, `box`, `model`, `policy_version` |
| `route` | `parcel_id`, `lane` (`auto`/`gemini`/`human`), `reason`, `confidence`, `thresholds` {auto, abstain, ship, retape, hold}; + `rule` (the safety-gate rule that decided), `tier` (`standard`/`fragile`/`high_value`), `bar` (the bar for Jev's action), `checks` [{rule, fired, lane, detail}] (every check, fired or not), `legacy_lane` + `legacy_reason` (what the old single 0.80 threshold would have done), `effective` {abstain, ship, retape, hold, paused}, `drift` (`normal`/`tightened`/`paused`); `escalated_from: "gemini"` on the second route event of a parcel that Gemini sent on to a person (that one has no `rule`) |
| `gemini_skipped` | `parcel_id`, `saved_ms_est`, `saved_cost_est`; + `basis` (e.g. "estimate: mean of 10 live second_look call(s) in this run", or "prior ..." before the first live call), `lane` (`auto` or `human`), `confidence`, `reason`, `by: "before_model_callback"` |
| `llm_start` | `call_id`, `agent`, `parcel_id` (null for shift_lead/teacher); + `live`, `job`, `job_label` |
| `llm_delta` | `call_id`, `text`; + `agent`, `thought` (true = a thought-summary chunk, false = answer text) |
| `llm_end` | `call_id`, `agent`, `ms`, `tokens_in`, `tokens_out`, `cost`, `live`, `output`; + `job`, `parcel_id`, `thought_tokens`, `error` |
| `tool_proposed` | `call_id` (the claims_clerk model call that proposed it), `agent: "claims_clerk"`, `tool` (`file_claim`/`issue_refund`), `args`; + `parcel_id` |
| `guard_verdict` | `call_id`, `allowed`, `rule`, `evidence` {tool, parcel_id, tracking, consignee_zip, amount_usd, jev_choice, jev_confidence, jev_damaged, auto_threshold, claim_on_damage, refund_limit_usd}; + `tool`, `parcel_id`, `by: "before_tool_callback"` |
| `decision` | `parcel_id`, `final_action`, `decided_by` (`jev`/`gemini`/`human`/`code`); + `reason`, `proposed_by`, `claim_id` |
| `human_queue` | `parcel_id`, `reason`; + `photo_url`, `declared`, `jev_action`, `confidence`, `second_look` (Gemini's verdict when it escalated, or the audit's shadow verdict), `kind` (`decide` = the parcel waits for the person; `audit` = shadow review of a parcel Jev already decided alone), `rule`, `tier`, `checks`, `legacy_lane`, `damaged`, `risk`, `probabilities`, `handling` (marks on the box, e.g. "FRAGILE (Handle with care) mark on the box"), `auto_action` (audit only), `truth` (the answer key, for the presenter chip only; never used by the gate) |
| `human_decided` | `parcel_id`, `action`; + `outcome` (graded against the answer key); audit items: `kind: "audit"`, `audit_error` and no `outcome` / `decision` (the parcel is already down the belt) |
| `audit` | `phase` (`start`/`done`/`relabel`), `parcel_id`, `auto_action`; `done`/`relabel` + `gemini_action`, `gemini_reason`, `needs_human`, `flagged`, `error` (the auto decision was wrong by the label), `label`, `label_source`; `start` + `rate` |
| `drift` | `level` (0/1/2), `state` (`normal`/`tightened`/`paused`), `offset`, `errors`, `n`, `alpha`, `parcel_id`, `reason`, `effective` {abstain, ship, retape, hold, paused} |
| `teach_proposal` | `proposal_id`, `diff`, `rationale`, `parcel_ids`; + `diff_text`, `live`, `call_id`, `base_version`, `rule_text` (one plain sentence, at most 20 words, no parcel ids), `evidence` [{parcel_id, photo_url, declared, person_action}] (the desk decisions it learned from), `status` (`proposed`, or `no_change` when the diff is empty) |
| `policy_version` | `version`, `policy` {name, preset, options, changed} |
| `adk_node` | `node`, `phase` (`start`/`end`). Nodes: `enter`, `tick`, `gate`, `check_claim`, `second_look_desk_0..2`, `second_look`, `read_label`, `claims_clerk`, `claim_ready`, `rest`, `summarise`, `shift_lead`, `finish`; teach graph: `teach_gather`, `teacher`, `teach_store` |
| `step` | mode 3 walk caption: `parcel_id`, `k`, `n` (3, or 5 when a label is read and a tool call is checked), `node`, `text` (`Step k of n · node · sentence`), `sentence`, `walk` (true while the first parcel walks slowly), `pause_s`. Sent for every parcel; with `walk` on, the first parcel pauses `pause_s` after each step and the next parcel waits until it has finished (at most 90 s) |
| `teach_rejudge` | the `POST /api/teach/{id}/rejudge` response body |
| `stats` | `parcels`, `lanes` {auto, gemini, human}, `gemini_skipped`, `jev_ms_avg`, `jev_cost`, `gemini_calls`, `gemini_cost`, `blocked_tools`, `human_pending`; + `total`, `saved_ms_est`, `saved_cost_est`, `allowed_tools`, `claims_filed`, `policy_version`, `thresholds`, and the split by job: `gemini_decision_calls`, `gemini_decision_ms_avg` (live calls only), `gemini_decision_cost`, `gemini_work_calls`, `gemini_work_cost` (clerk + report + teacher), `gemini_jobs` {job: {calls, cost, ms_avg}}, `safety` {audit {rate, alpha, seed, started, n, pending, flagged, errors, observed_error, ucb95, label_source}, drift {level, state, offset, paused, history}, rules {rule: count}, auto_key {n, errors, note: demo only}} |
| `run_end` | `scorecard`, `report` ({headline, report} from shift_lead; null in h2h mode) |

### Mode 2 events (`mode: "h2h"`)

`run_start` (+ `prices` {jev_in_per_m, jev_out_per_m, gemini_in_per_m, gemini_out_per_m, gemini_source}),
then per parcel: `parcel`, `llm_start`/`llm_delta`/`llm_end` for `gemini_reflex`, two `h2h_answer`, one
`h2h_result`, one `h2h_stats`; then `run_end` with `scorecard` = the final `h2h_stats` body and `report: null`.
No `route`, `gemini_skipped`, `decision`, `human_queue` or tool events: no thresholds, no lanes, no claims.

| type | fields |
|---|---|
| `h2h_answer` | `side` (`jev`/`gemini`), `parcel_id`, `call_id`, `action` (ship/retape/hold/return; null on error), `probabilities` {ship, retape, hold, return}, `p_chosen` (Jev: its calibrated probability for its choice; Gemini: its stated `confidence`, clamped to 0-1), `ms` (wall clock dispatch -> parsed answer, same clock for both; a replayed answer reports its recorded ms), `call_ms`, `tokens_in`, `tokens_out` (Gemini: output + thinking), `cost`, `live`, `model`, `outcome` (`correct`/`safe`/`wrong`/`near_miss`, graded by `engine.grade` against the answer key); Jev + `confidence`; Gemini + `confidence` (stated by the LLM), `reason`, `thought_tokens`; `error` when a side failed |
| `h2h_result` | `parcel_id`, `declared`, `truth`, `jev` (an h2h_answer body), `gemini` (same), `agree` |
| `h2h_stats` | `parcels`, `both_answered`, `agree`, `agreement_rate`, `jev` / `gemini` {parcels, answered, errors, correct, safe, wrong, near_miss, accuracy, ms_mean, ms_p95 (nearest rank), tokens_in_mean, tokens_out_mean, cost_total, cost_per_1k, live_calls, mean_p_chosen}, `gemini_wait_s` ("if Gemini were the reflex, the belt would wait X s per parcel" = Gemini's mean answer latency), `jev_wait_s`, `calibration` {jev, gemini: [{lo, hi, n, mean_p, accuracy}] for bins [0,.6) [.6,.8) [.8,.95) [.95,1]}, `confidence_kind`, `prices` |

Same question: Jev gets only the `action` Choice (`reflex.action_question`: the four option texts of the
policy in force, the standard instruction, state = station, declared contents, handling "none noted", photo).
`gemini_reflex` (ADK `LlmAgent`, `output_schema=ReflexAnswer` {action, probabilities, confidence, reason})
gets the same photo and the same words (`h2h.question_text`). Both calls start at the same moment
(`asyncio.gather`); the tick waits for both before the next parcel. Recorded under `BELT_RECORD=1` as
`jev["h2h|<parcel>"]`, `gemini_reflex[<parcel>]`, `gemini_reflex_usage[<parcel>]`; replay never invents a
Gemini answer (no recording -> the side shows an error).

Extra event types (not in the contract): `thresholds` {auto, abstain} after `POST /api/thresholds`;
`teach_approved` {proposal_id, version}; `teach_error` {error, call_id}; `context_test` (same body as the
`POST /api/context-test` response); `run_stopped`; `run_error` {error}.

## REST

| method + path | body | returns |
|---|---|---|
| `POST /api/run` | `{mode: "workflow"\|"h2h", pace: seconds (0-5), limit: n\|null, seed?: false\|true\|"only", set?: "r3", ids?: ["P-0101", ...], walk?: bool}` | `{started, parcels (count), set, walk}`; 400 on another mode or seed, a pace outside 0-5, a limit outside 1-400, an unknown `set`, an unknown parcel id or an empty `ids` list. `ids` (max 30, order kept) wins over `set`; both override `limit` and `seed`. `walk` applies to mode `workflow` only. Cancels a running run. Clears the human queue and resets the safety monitor (workflow). `seed: true` adds the seeded safety cases (`photos/seeded/`, e.g. `P-S01`) after the real photos, `"only"` runs just those. |
| `POST /api/stop` | | `{stopped: true}` (stream: `run_stopped`) |
| `GET /api/thresholds` | | `{auto, abstain, ship, retape, hold}` (`auto` = the ship bar, kept for the slider) |
| `POST /api/thresholds` | `{auto?\|ship?, abstain?, retape?, hold?}` | same shape; 400 unless 0 <= abstain <= every bar <= 1. Applies from the next parcel. |
| `GET /api/safety` | | `{thresholds, effective, source, defaults, design, floors, legacy, never_auto, params, config {audit_rate, alpha}, audit, drift, rules, auto_key, audits: [audit records], routes: {parcel: {lane, rule, tier, bar, legacy_lane}}, calibration}` (`calibration` = `belt/calibration.json` without its rows, or null) |
| `POST /api/safety` | `{ship?, retape?, hold?, abstain?, audit_rate?, alpha?, reset_drift?: true}` | the `GET` body; 400 on a value outside 0-1 or abstain above a bar |
| `POST /api/judge` | `{id, action: "ship"\|"retape"\|"hold"\|"return"\|"missed"}` | `{id, action, outcome, truth}`; outcome `correct`/`safe`/`wrong`/`near_miss`, and for `missed` (the 2 s ran out: the belt does not wait) `near_miss` when the key says hold/return, else `missed`; 400 bad action, 404 unknown parcel |
| `POST /api/you/jev` | `{ids: [...], source?: "live"\|"replay"}` | mode 1 summary: Jev on the same parcels. `{source, source_label, answers: [{id, choice, action, confidence, probabilities, damaged, risk, outcome (Jev's own choice graded by the key), truth, lane, rule (what the safety gate would do), live, ms, call_id}], summary {n, correct, safe, wrong, near_miss, ms_avg, errors}}`. live (default with a key): one call per parcel now, 6 at a time; a failed call answers from `belt/replay.json` and says `live: false`. replay: recorded answers only, no request. |
| `GET /api/policy` | | policy state: `options`, `name`, `preset`, `version`, `changed`, `presets`, `default`, `thresholds`, ... |
| `POST /api/policy` | `{preset: "standard"\|"peak"\|"hazmat"}` or `{options: {ship?, retape?, hold?, return?, file_claim?}, name?}` | new state; 400 on unknown option / empty / > 400 chars |
| `POST /api/human/{parcel_id}` | `{action: "ship"\|"retape"\|"hold"\|"return"}` | the queue item (`status: "decided"`, `action`, `outcome`); 404 not queued, 400 bad action or already decided. For a `kind: "audit"` item: the answer becomes the audit label (`audit` in the reply, `outcome: null`), the parcel's own decision and score are not touched, and a drift check runs. The review modal and the desk buttons both call this. |
| `POST /api/teach/run` | | the proposal `{proposal_id, diff, diff_text, rationale, rule_text, evidence, parcel_ids, status: "proposed"\|"no_change", live, call_id, base_version, applied_version, warnings}`. `warnings` = the overlap guard (`floor.overlap_warnings`): a condition word (dent, scuff, leak, tape, ...) the change added to one option that another option also names, e.g. `"'dent' added to retape but also in ship, hold: the options overlap"`; words after "no / not / without / never" do not count. Warnings never block the proposal. Option texts never contain parcel ids (they are stripped). `no_change` = the policy already matches the desk; it cannot be approved or re-judged. Synchronous (~10 s live). 400 if no human decisions yet, 409 if already running, 502 if Gemini's proposal fails validation. Never applies anything. |
| `POST /api/teach/{proposal_id}/approve` | | `{proposal_id, status: "approved", version, policy}`; 404 unknown, 409 already approved or `no_change`. Bumps the policy version; the next Jev call uses the new texts. |
| `POST /api/teach/{proposal_id}/rejudge` | | Jev again on the proposal's evidence parcels under the old texts (`base_options`) and the new ones, 6 calls at a time: `{proposal_id, version_before, version_after, k, matches_before, matches_after, left_desk_before, left_desk_after, desk_bar, rows: [{parcel_id, photo_url, declared, person_action, before {action, confidence, damaged, risk, lane, rule, checks, live, call_id}\|null, after (same)\|null, live, match_before, match_after, leaves_desk, still_person_reason}]}`. Jev's own top choice (`model_choice`) is compared with the person. `lane` (`auto`/`gemini`/`human`), `rule` and `checks` (the names of every fired check) come from the belt's own safety gate `floor.gate_route()` on that answer with the parcel's declared contents and handling marks and the current bars + drift, so a better answer that is still unsure shows as still going to a person. `leaves_desk` = `after.lane != "human"`; `left_desk_*` count them. `still_person_reason` (null when it leaves the desk) says why in plain words, e.g. "right answer, but confidence 0.36 is under the 0.40 desk bar". `desk_bar` = the abstain bar used. A failed call gives `null` for that side. 404 unknown, 409 `no_change`. Works before or after approve. Stream: `teach_rejudge`. |
| `POST /api/context-test` | `{photo?, a?, b?}` | two Jev calls on one photo with two declared contents |
| `GET /api/inspect/{call_id}` | | full call record (Jev: exact multipart request + verbatim response, key redacted; Gemini: request summary, thoughts, raw text, parsed, function_calls, usage, cost) |
| `GET /api/photos/{file}` | | JPEG, e.g. `P-0101.jpg`, `DEMO-DENTED.jpg` |

Extra REST (not in the contract): `GET /api/human` {pending, decided} (items carry `truth`); `GET /api/teach` {proposals} (every proposal with `rule_text`, `evidence`, `status`, `applied_version`; the page hydrates the desk and the teacher from these two after a reload);
`POST /api/policy/probe` {photo, declared?}; `GET /legacy`. Extra event: `thresholds` now carries
{auto, abstain, ship, retape, hold}. All original endpoints remain
(`/api/events`, `/api/call/{id}`, `/api/calls`, `/api/manifest`, `/api/photo/{id}.jpg`, `/api/photos`,
`/api/label/{n}.png`, `/api/judge`, `/api/health`). The webcam route and the `LIVE-*` fallback photos were
removed with webcam mode.

## Semantics the front end should know (deviations and clarifications)

1. **Several `decision` events per parcel.** Gemini-lane parcels get theirs when the second look returns
   (seconds later, the belt has moved on). Human-lane parcels get `final_action: "hold", decided_by: "code"`
   (held, belt keeps moving), then `decided_by: "human"` after `POST /api/human`. A damaged parcel whose claim
   tool call was allowed gets `final_action: "file_claim"` or `"issue_refund"`, `decided_by: "code"`,
   `proposed_by: "claims_clerk"`. The last one wins.
2. **Two `route` events** for a parcel Gemini sends on (`needs_human`, invalid action, or Gemini says ship while
   Jev sees damage >= 0.60): first `lane: "gemini"`, then `lane: "human"` with `escalated_from: "gemini"`.
   `stats.lanes` counts each parcel once, in its final lane, so the three numbers add up to `parcels`.
3. **`gemini_skipped` fires for the auto lane and for the abstain (human) lane**: both skip Gemini. `lane`
   says which. Every parcel goes through the `second_look` LlmAgent; its `before_model_callback` returns an
   `LlmResponse` (no model call) unless Jev's confidence is in the defer band at that moment.
4. **Savings are estimates; Gemini cost is from the published price.** `saved_*_est` = mean of this run's live
   second_look calls only (like with like; before the first one, a prior of 4,000 ms / $0.002, and `basis`
   says which). Gemini cost uses the published Gemini 3.5 Flash-Lite price, $0.30 / 1M input and $2.50 / 1M
   output tokens including thinking (ai.google.dev/gemini-api/docs/pricing, read 2026-10-30; the Vertex AI
   price is assumed to be the same). `BELT_GEMINI_PRICE_IN` / `BELT_GEMINI_PRICE_OUT` override it (then
   labelled "assumed"). Jev cost is $0.042 / 1M input tokens. Replay calls cost 0 in mode 3; in mode 2 the
   cost of a replayed answer is computed from its recorded tokens (flagged `live: false`).
5. **claims_clerk makes two model calls per label**: one that proposes the tool call (`llm_end.output` is
   `{"function_call": {name, args}}`), then one that returns the ClaimPacket after the tool (or the guard's
   block message) answered. Each has its own `call_id`; `tool_proposed`/`guard_verdict` carry the first.
6. **Claims are per parcel now.** A label is read when Jev says hold/return with damaged >= 0.60. A blocked or
   misread proposal gets one re-scan (a new label read) per parcel, and label reads stop at MAX_TICKS (30).
   Label #2 of each run is smudged on purpose, so a 30-parcel run normally shows one `packet_unreadable` block.
   Guard rules, first match wins: `unknown_tool`, `no_jev_verdict_for_parcel`, `duplicate_claim_for_parcel`,
   `packet_unreadable`, `jev_says_intact` (refund while Jev picks ship/retape with confidence >= auto),
   `jev_sees_no_damage` (damaged < 0.60), `refund_amount_invalid`, `refund_over_limit_needs_human` (> $150),
   else allowed by `jev_damaged_and_packet_readable`.
7. **`adk_node` start for `enter` comes before `run_start`**, and `finish`'s end after `run_end`.
8. **Head-to-head mode** (`mode: "h2h"`): see "Mode 2 events" above. The Jev-only `model` mode was removed.
9. **`run_end.scorecard`** = the original scorecard (`correct`, `safe`, `wrong`, `near_miss`, ...) merged with the
   `stats` fields (stats win on `gemini_calls`: model calls, not label reads). Human decisions made after
   `run_end` regrade the parcel; a fresh `stats` event follows each `human_decided`.
10. **REPLAY** (`BELT_REPLAY=1`, or no `TYPESAFE_API_KEY` for Jev): every event still fires, with `live: false`.
    second_look, claims_clerk (including its tool proposal), gemini_reflex, shift_lead and teacher answer from
    `belt/replay.json` or are built by code and say so ("Replay: ... not Gemini"). A replayed Jev call sends no
    request, so after a policy change it returns the answer recorded under the Standard policy.
11. **Audited auto parcels are not skipped.** Their `second_look` runs for real (shadow) on a desk, so no
    `gemini_skipped` fires for them; their `decision` stays `decided_by: "jev"`. The `second_look` prompt gets a
    "Floor note" line: the rule that sent the parcel, or "audit sample: Jev already decided X alone".
12. **The gate's context is not Jev's input.** Jev still gets the photo + declared contents only (handling
    "none noted"); the gate also reads the handling marks (`engine.handling_marks`, from the manifest's sticker
    fields, standing in for a marks / label scan). That is why `marks_vs_declared` can catch a parcel whose
    damage is out of the camera's view.
13. **Mode 1 grading.** `missed` is its own outcome; a missed parcel the key says to hold/return is a
    near-miss (it went down the belt unchecked).

### Stage changes (fix-spec section 4, 2026-10-30)

- **Named sets:** `belt/sets.py` holds `r3` (12 parcels for Round 3). `POST /api/run {set}` / `{ids}`; see the table above.
- **Walk captions:** the `step` event. Captions are plain sentences, e.g. `Step 2 of 5 · gate · 0.29 is under 0.40 → human desk, Gemini skipped`.
- **Plain reasons:** the low-confidence check reads `confidence 0.29 < desk bar 0.40 (Jev unsure)` (was "abstain"); the rule id `abstain_low_confidence` is unchanged.
- **Policy-keyed replay:** live Jev calls under a non-default policy are recorded under `jev_policy` keyed by parcel and a hash of the option texts (`jev.policy_key`). Replay looks there first, then falls back to the default-policy answer and says so in the note.
- **Label #2 smudge** (`belt/label.py`) is opaque: the ZIP and tracking digits cannot be read, so the tool gate blocks that claim with `packet_unreadable`.
