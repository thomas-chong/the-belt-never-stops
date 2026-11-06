// Wire types for the belt server (SSE GET /api/stream + REST). One place, used everywhere.

export type Lane = "auto" | "gemini" | "human";
export type Mode = "you" | "h2h" | "workflow";
export type Agent = "second_look" | "claims_clerk" | "shift_lead" | "teacher" | "gemini_reflex";
/** What a Gemini call is for. Only "decision" calls make the same kind of decision Jev makes. */
export type Job = "decision" | "clerk" | "report" | "teacher";
export type Action = "ship" | "retape" | "hold" | "return" | "file_claim" | "spot_check" | string;

export interface Thresholds {
  auto: number;
  abstain: number;
  /** per-action bars of the safety gate (auto = ship) */
  ship?: number;
  retape?: number;
  hold?: number;
}

/** One check of the safety gate (belt/floor.py gate_route). */
export interface GateCheck {
  rule: string;
  fired: boolean;
  lane: Lane;
  detail: string;
}
export interface EffectiveBars {
  abstain: number;
  ship: number;
  retape: number;
  hold: number;
  paused: boolean;
}
export type DriftState = "normal" | "tightened" | "paused";

export interface Declared {
  text?: string;
  contents?: string;
  fragile?: boolean;
  [k: string]: unknown;
}

interface Base {
  ts: number;
}

export interface RunStartEv extends Base {
  type: "run_start";
  mode?: Mode;
  total?: number;
  thresholds?: Thresholds;
  policy_version?: number;
  credit?: string;
  jev_model?: string;
  gemini_model?: string;
  gemma_model?: string | null;
  prices?: H2HPrices;
}
export interface ParcelEv extends Base {
  type: "parcel";
  parcel_id: string;
  photo_url: string;
  declared: Declared | string;
  index: number;
  total: number;
  credit?: string;
}
export interface JevCallEv extends Base {
  type: "jev_call";
  call_id: string;
  parcel_id: string;
  ms: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  live: boolean;
  probabilities: Record<string, number>;
  confidence: number;
  action: Action;
  policy_version?: number;
  model_choice?: string;
  why?: string;
  damaged?: number;
  risk?: number;
}
export interface RouteEv extends Base {
  type: "route";
  parcel_id: string;
  lane: Lane;
  reason: string;
  confidence: number;
  thresholds: Thresholds;
  escalated_from?: Lane;
  rule?: string;
  tier?: string;
  bar?: number | null;
  checks?: GateCheck[];
  legacy_lane?: Lane;
  legacy_reason?: string;
  effective?: EffectiveBars;
  drift?: DriftState;
}
export interface GeminiSkippedEv extends Base {
  type: "gemini_skipped";
  parcel_id: string;
  saved_ms_est: number;
  saved_cost_est: number;
  lane?: Lane;
  basis?: string;
}
export interface LlmStartEv extends Base {
  type: "llm_start";
  call_id: string;
  agent: Agent;
  job?: Job;
  job_label?: string;
  parcel_id?: string;
}
export interface LlmDeltaEv extends Base {
  type: "llm_delta";
  call_id: string;
  text: string;
  thought?: boolean;
}
export interface LlmEndEv extends Base {
  type: "llm_end";
  call_id: string;
  agent: Agent;
  job?: Job;
  ms: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  live: boolean;
  output: unknown;
}
export interface ToolProposedEv extends Base {
  type: "tool_proposed";
  call_id: string;
  agent: Agent;
  tool: string;
  args: Record<string, unknown>;
}
export interface GuardVerdictEv extends Base {
  type: "guard_verdict";
  call_id: string;
  allowed: boolean;
  rule: string;
  evidence: Record<string, unknown> | string;
}
export interface LabelReadEv extends Base {
  type: "label_read";
  parcel_id: string;
  label_index: number;
  url: string;
  scan: number;
  declared?: string;
}
export interface ClaimPacket {
  tracking?: string;
  consignee_zip?: string;
  service?: string;
  marks?: string[];
  declared_contents?: string;
  claim_note?: string;
}
export interface ClaimPacketEv extends Base {
  type: "claim_packet";
  parcel_id: string;
  packet: ClaimPacket;
  graded: { correct: boolean; tracking_ok: boolean; zip_ok: boolean; marks_ok: boolean; label_index: number;
    expected: { tracking: string; zip: string; marks: string[] } };
  filed: boolean;
  took: number;
  retry: boolean;
  claim?: { claim_id: string; tool: string; [k: string]: unknown } | null;
  scan: number;
  url: string;
  declared?: string;
  jev?: { choice?: string; confidence: number; damaged: number };
}
export interface DecisionEv extends Base {
  type: "decision";
  parcel_id: string;
  final_action: Action;
  decided_by: string;
}
export interface SecondLookVerdict {
  action?: string;
  reason?: string;
  needs_human?: boolean;
}
export interface HumanQueueEv extends Base {
  type: "human_queue";
  parcel_id: string;
  reason: string;
  kind?: "decide" | "audit";
  photo_url?: string;
  declared?: string;
  jev_action?: string;
  confidence?: number;
  second_look?: SecondLookVerdict | null;
  rule?: string | null;
  tier?: string | null;
  checks?: GateCheck[] | null;
  legacy_lane?: Lane | null;
  damaged?: number | null;
  risk?: number | null;
  probabilities?: Record<string, number> | null;
  handling?: string;
  auto_action?: string | null;
  /** the answer key (presenter chip in the review pop-up) */
  truth?: string | null;
}
/** GET /api/human item (what the server keeps for a held parcel). */
export interface HumanItem {
  parcel_id: string;
  reason: string;
  status: "pending" | "decided";
  action?: string | null;
  kind?: "decide" | "audit";
  photo_url?: string;
  declared?: string;
  jev?: { choice?: string; confidence?: number; probabilities?: Record<string, number>; damaged?: number } | null;
  second_look?: SecondLookVerdict | null;
  rule?: string | null;
  checks?: GateCheck[] | null;
  handling?: string;
  damaged?: number | null;
  risk?: number | null;
  auto_action?: string | null;
  truth?: string | null;
}
export interface HumanDecidedEv extends Base {
  type: "human_decided";
  parcel_id: string;
  action: Action;
  kind?: "decide" | "audit";
  outcome?: string | null;
  audit_error?: boolean;
}
export interface AuditEv extends Base {
  type: "audit";
  phase: "start" | "done" | "relabel";
  parcel_id: string;
  auto_action?: string | null;
  gemini_action?: string | null;
  gemini_reason?: string | null;
  needs_human?: boolean;
  flagged?: boolean;
  error?: boolean;
  label?: string | null;
  label_source?: string | null;
  rate?: number;
}
export interface DriftEv extends Base {
  type: "drift";
  level: number;
  state: DriftState;
  offset: number;
  errors?: number;
  n?: number;
  alpha?: number;
  reason?: string;
  parcel_id?: string;
  effective?: EffectiveBars;
}

export interface SafetyStats {
  audit: {
    rate: number;
    alpha: number;
    seed?: string;
    started: number;
    n: number;
    pending: number;
    flagged: number;
    errors: number;
    observed_error: number | null;
    ucb95: number | null;
    label_source: string;
  };
  drift: { level: number; state: DriftState; offset: number; paused: boolean; history: DriftHistory[] };
  rules: Record<string, number>;
  auto_key: { n: number; errors: number; note: string };
}
export interface DriftHistory {
  ts: number;
  level: number;
  state: DriftState;
  offset: number;
  errors?: number;
  n?: number;
  reason: string;
}
export interface AuditRecord {
  parcel_id: string;
  auto_action?: string | null;
  status: string;
  gemini_action?: string | null;
  gemini_reason?: string | null;
  flagged?: boolean;
  error?: boolean;
  label?: string | null;
  label_source?: string | null;
}
export interface CalibrationAction {
  n_choice: number;
  data_bar: number | null;
  floor: number;
  in_force: number;
  covered: number;
  errors: number;
  risk: number | null;
  ucb95: number | null;
  harmful_in_choice?: number;
}
export interface Calibration {
  source?: string;
  n: number;
  alpha: number;
  n_min?: number;
  per_action: Record<string, CalibrationAction>;
  in_force: Record<string, number>;
  gate: { lanes: Record<Lane, number>; coverage: number | null; auto_errors: number; auto_error_rate: number | null; auto_ucb95: number | null };
  legacy: { auto: number; coverage: number | null; auto_errors: number };
  n_needed_for_alpha: number;
  note: string;
  [k: string]: unknown;
}
export interface SafetyState extends SafetyStats {
  thresholds: Thresholds & { ship: number; retape: number; hold: number };
  effective: EffectiveBars;
  source: string;
  defaults?: Record<string, number>;
  design?: Record<string, number>;
  floors: Record<string, number>;
  legacy: { auto: number; abstain: number };
  never_auto: string[];
  params: {
    cross_damaged: number;
    cross_risk: number;
    fragile_retape_bump: number;
    high_value_bump: number;
    tighten_step: number;
    fragile_words?: string[];
    high_value_words?: string[];
  };
  config: { audit_rate: number; alpha: number };
  audits: AuditRecord[];
  routes: Record<string, { lane?: Lane; rule?: string; tier?: string; bar?: number | null; legacy_lane?: Lane }>;
  calibration: Calibration | null;
}

/** Mode 1 summary: Jev on the parcels the person sorted. */
export interface YouJevAnswer {
  id: string;
  choice?: string;
  action?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  damaged?: number;
  risk?: number;
  outcome?: string;
  truth: string;
  lane?: Lane;
  rule?: string;
  live?: boolean;
  ms?: number;
  call_id?: string;
  error?: string;
}
export interface YouJevResult {
  source: "live" | "replay";
  source_label: string;
  answers: YouJevAnswer[];
  summary: { n: number; correct: number; safe: number; wrong: number; near_miss: number; ms_avg: number | null; errors: number };
}
export interface JudgeResult {
  id?: string;
  action?: string;
  outcome?: string;
  truth?: string;
}
export interface Evidence {
  parcel_id: string;
  photo_url: string;
  declared?: string | null;
  person_action?: string | null;
}
export interface TeachProposalEv extends Base {
  type: "teach_proposal";
  proposal_id: string;
  diff: PolicyDiff | string;
  rationale: string;
  parcel_ids: string[];
  diff_text?: string;
  /** the rule in one plain sentence (no "New rule:" prefix, no parcel ids) */
  rule_text?: string;
  evidence?: Evidence[];
  /** "no_change": the policy already matches the desk (no Approve button) */
  status?: "proposed" | "no_change" | "approved" | string;
  base_version?: number;
  /** the overlap guard: a condition the change added that another option also names */
  warnings?: string[];
}
/** GET /api/teach item */
export interface ProposalPublic extends Omit<TeachProposalEv, "type" | "ts"> {
  applied_version?: number | null;
}
export interface RejudgeSide {
  action: string;
  confidence: number;
  live?: boolean;
  call_id?: string;
  damaged?: number;
  risk?: number;
  /** the lane the belt's safety gate (floor.gate_route) gives this answer now */
  lane?: "auto" | "gemini" | "human";
  /** the gate check that set the lane */
  rule?: string;
  /** every gate check that fired */
  checks?: string[];
}
export interface RejudgeRow extends Evidence {
  before: RejudgeSide | null;
  after: RejudgeSide | null;
  live?: boolean;
  match_before?: boolean;
  match_after?: boolean;
  /** after.lane != "human": this parcel would no longer go to a person */
  leaves_desk?: boolean;
  /** why it still goes to a person, in plain words (null when it leaves the desk) */
  still_person_reason?: string | null;
}
export interface RejudgeResult {
  proposal_id: string;
  version_before: number;
  version_after: number;
  rows: RejudgeRow[];
  matches_before: number;
  matches_after: number;
  left_desk_before?: number;
  left_desk_after?: number;
  /** the desk bar (abstain) the gate used */
  desk_bar?: number;
  k: number;
}
export interface TeachRejudgeEv extends Base, RejudgeResult {
  type: "teach_rejudge";
}
/** caption bar (A6): one plain sentence per graph step; the walked parcel pauses at each */
export interface StepEv extends Base {
  type: "step";
  parcel_id: string;
  k: number;
  n: number;
  node: string;
  text: string;
  sentence?: string;
  walk?: boolean;
  pause_s?: number;
}
export interface PolicyVersionEv extends Base {
  type: "policy_version";
  version: number;
  policy: Policy;
}
export interface AdkNodeEv extends Base {
  type: "adk_node";
  node: string;
  phase: "start" | "end" | "skip" | "wait" | "error" | string;
}
export interface Stats {
  parcels: number;
  lanes: { auto: number; gemini: number; human: number };
  gemini_skipped: number;
  jev_ms_avg: number;
  jev_cost: number;
  gemini_calls: number;
  gemini_cost: number;
  blocked_tools: number;
  human_pending: number;
  safety?: SafetyStats;
  saved_ms_est?: number;
  saved_cost_est?: number;
  /** decision calls (2nd look) vs clerk / report / teacher work, split by the server */
  gemini_decision_calls?: number;
  gemini_decision_ms_avg?: number | null;
  gemini_decision_cost?: number;
  gemini_work_calls?: number;
  gemini_work_cost?: number;
  gemini_jobs?: Partial<Record<Job, { calls: number; cost: number; ms_avg: number | null }>>;
}
export interface StatsEv extends Base, Stats {
  type: "stats";
}
export interface RunEndEv extends Base {
  type: "run_end";
  scorecard: Record<string, unknown>;
  report: string | null | { headline?: string; report?: string; body?: string; [k: string]: unknown };
}

export interface ThresholdsEv extends Base, Thresholds {
  type: "thresholds";
}
export interface RunStoppedEv extends Base {
  type: "run_stopped";
}
export interface RunErrorEv extends Base {
  type: "run_error";
  error: string;
}
export interface TeachApprovedEv extends Base {
  type: "teach_approved";
  proposal_id: string;
  version: number;
}
export interface TeachErrorEv extends Base {
  type: "teach_error";
  error: string;
  call_id?: string;
}

// ── mode 2: Jev vs Gemini, same parcel, same question (belt/h2h.py) ──

export interface H2HPrices {
  jev_in_per_m: number;
  jev_out_per_m: number;
  gemini_in_per_m: number;
  gemini_out_per_m: number;
  gemini_source: string;
  gemma_per_hour?: number;
}
/** One side's answer for one parcel. Gemini's probabilities/confidence are stated by the LLM. */
export interface H2HSide {
  call_id?: string | null;
  action: string | null;
  probabilities?: Record<string, number>;
  /** Jev: its probability for its chosen option (calibrated). Gemini: its stated confidence. */
  p_chosen?: number | null;
  confidence?: number;
  reason?: string;
  ms?: number | null;
  call_ms?: number | null;
  tokens_in?: number;
  tokens_out?: number;
  thought_tokens?: number;
  cost: number;
  live: boolean;
  model?: string;
  outcome: "correct" | "safe" | "wrong" | "near_miss" | null;
  error?: string;
}
export interface H2HAnswerEv extends Base, H2HSide {
  type: "h2h_answer";
  side: "jev" | "gemini" | "gemma";
  parcel_id: string;
}
export interface H2HResultEv extends Base {
  type: "h2h_result";
  parcel_id: string;
  declared: string;
  truth: string;
  jev: H2HSide;
  gemini: H2HSide;
  gemma?: H2HSide;
  agree: boolean;
}
export interface H2HSideStats {
  parcels: number;
  answered: number;
  errors: number;
  correct: number;
  safe: number;
  wrong: number;
  near_miss: number;
  accuracy: number | null;
  ms_mean: number | null;
  ms_p95: number | null;
  tokens_in_mean: number | null;
  tokens_out_mean: number | null;
  cost_total: number;
  cost_per_1k: number | null;
  live_calls: number;
  mean_p_chosen: number | null;
}
export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  mean_p: number | null;
  accuracy: number | null;
}
export interface H2HBoard {
  parcels: number;
  both_answered: number;
  agree: number;
  agreement_rate: number | null;
  jev: H2HSideStats;
  gemini: H2HSideStats;
  gemma?: H2HSideStats;
  gemini_wait_s: number | null;
  gemma_wait_s?: number | null;
  jev_wait_s: number | null;
  calibration: { jev: CalibrationBin[]; gemini: CalibrationBin[]; gemma?: CalibrationBin[] };
  confidence_kind: { jev: string; gemini: string };
  prices: H2HPrices;
}
export interface H2HStatsEv extends Base, H2HBoard {
  type: "h2h_stats";
}

export type BeltEvent =
  | StepEv
  | TeachRejudgeEv
  | AuditEv
  | DriftEv
  | H2HAnswerEv
  | H2HResultEv
  | H2HStatsEv
  | ThresholdsEv
  | RunStoppedEv
  | RunErrorEv
  | TeachApprovedEv
  | TeachErrorEv
  | RunStartEv
  | ParcelEv
  | JevCallEv
  | RouteEv
  | GeminiSkippedEv
  | LlmStartEv
  | LlmDeltaEv
  | LlmEndEv
  | ToolProposedEv
  | GuardVerdictEv
  | LabelReadEv
  | ClaimPacketEv
  | DecisionEv
  | HumanQueueEv
  | HumanDecidedEv
  | TeachProposalEv
  | PolicyVersionEv
  | AdkNodeEv
  | StatsEv
  | RunEndEv;

/** A policy diff: one row per option whose words change. Servers may also send a plain string. */
export interface PolicyDiffRow {
  option: string;
  before: string;
  after: string;
}
export type PolicyDiff = PolicyDiffRow[] | { changes?: PolicyDiffRow[]; [k: string]: unknown };

export interface Policy {
  options: Record<string, string>;
  name?: string;
  version?: number;
  presets?: Record<string, { name: string; options: Record<string, string> }>;
  changed?: string[];
  [k: string]: unknown;
}

export interface ContextSide {
  tag: string;
  declared: string;
  decision?: { action: string; confidence?: number; why?: string };
  probabilities?: Record<string, number>;
  call_id?: string;
  ms?: number;
  [k: string]: unknown;
}
export interface ContextResult {
  photo: string;
  url: string;
  sides: ContextSide[];
  different?: boolean;
  [k: string]: unknown;
}

export interface InspectRecord {
  id?: string;
  call_id?: string;
  kind?: string;
  model?: string;
  live?: boolean;
  ms?: number;
  request?: unknown;
  response?: unknown;
  [k: string]: unknown;
}
