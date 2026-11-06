// In-browser event replayer. Speaks the same contract as the server (types.ts) so the page can be
// built, rehearsed and screenshotted with no backend. Every call it reports is marked live: false
// (the page shows REPLAY), and the Inspector says plainly that no network call was made.
import type { BeltApi, RunRequest, StreamStatus } from "./api";
import type {
  Agent,
  BeltEvent,
  CalibrationBin,
  ContextResult,
  H2HBoard,
  H2HSide,
  Evidence,
  GateCheck,
  HumanItem,
  InspectRecord,
  JudgeResult,
  Lane,
  SafetyState,
  YouJevResult,
  Policy,
  PolicyDiffRow,
  ProposalPublic,
  RejudgeResult,
  RejudgeRow,
  Thresholds,
} from "./types";

const MOCK_EVIDENCE: Evidence[] = [
  { parcel_id: "P-0103", photo_url: "", declared: "Power bank, 1", person_action: "hold" },
  { parcel_id: "P-0110", photo_url: "", declared: "Phone charger, 2", person_action: "hold" },
];

type NoTs<T> = T extends unknown ? Omit<T, "ts"> : never;

type Kind = "intact" | "scuffed" | "dented" | "crushed" | "refund" | "battery" | "wet";

interface Spec {
  kind: Kind;
  declared: string;
  fragile?: boolean;
}

const SCRIPT: Spec[] = [
  { kind: "intact", declared: "Paperback books, 3" },
  { kind: "dented", declared: "Kitchen towels, 6" },
  { kind: "battery", declared: "Power bank, 1" },
  { kind: "refund", declared: "Headphones, 1" },
  { kind: "intact", declared: "Board game, 1" },
  { kind: "crushed", declared: "Glass vase, 2 pcs", fragile: true },
  { kind: "scuffed", declared: "T-shirts, 4" },
  { kind: "wet", declared: "Printer paper, 1 ream" },
  { kind: "intact", declared: "Coffee beans, 2 bags" },
  { kind: "battery", declared: "Cordless drill, 1" },
  { kind: "intact", declared: "Running shoes, 1 pair" },
  { kind: "dented", declared: "Desk lamp, 1" },
  { kind: "intact", declared: "Notebooks, 10" },
  { kind: "battery", declared: "E-reader, 1" },
  { kind: "scuffed", declared: "Yoga mat, 1" },
  { kind: "intact", declared: "Phone case, 2" },
  { kind: "crushed", declared: "Ceramic mugs, 4", fragile: true },
  { kind: "battery", declared: "Bike light, 1" },
  { kind: "intact", declared: "Socks, 6 pairs" },
  { kind: "refund", declared: "Smart watch, 1" },
  { kind: "intact", declared: "Puzzle, 1000 pcs" },
  { kind: "battery", declared: "Laptop, 1" },
  { kind: "scuffed", declared: "Cookbook, 1" },
  { kind: "intact", declared: "Candles, 3" },
];

const DEFAULT_OPTIONS: Record<string, string> = {
  ship: "The box is intact and closed. Send it on.",
  retape: "The tape or a flap is open, or the box has small dents, but nothing is crushed, torn or wet. Retape it.",
  hold: "The box is crushed, torn, punctured or wet, or dented with fragile contents: hold it for a person.",
  return: "The label is missing or the parcel is refused: return it to the sender.",
  file_claim: "The contents look damaged and a claim packet is ready: file a damage claim.",
};

const TAUGHT_HOLD =
  "The box is crushed, torn, punctured or wet, or dented with fragile contents, OR it carries a lithium " +
  "battery or hazmat sticker: hold it for a hazmat check.";

const JOB: Record<Agent, "decision" | "clerk" | "report" | "teacher"> = {
  second_look: "decision",
  gemini_reflex: "decision",
  claims_clerk: "clerk",
  shift_lead: "report",
  teacher: "teacher",
};

const MOCK_PRICES = { jev_in_per_m: 0.042, jev_out_per_m: 0, gemini_in_per_m: 0.3, gemini_out_per_m: 2.5, gemini_source: "mock: published Flash-Lite price" };
const TRUTH: Record<Kind, string> = { intact: "ship", scuffed: "ship", dented: "retape", crushed: "hold", refund: "ship", battery: "ship", wet: "hold" };
const GEM_PICK: Record<Kind, string> = { intact: "ship", scuffed: "ship", dented: "hold", crushed: "hold", refund: "ship", battery: "hold", wet: "hold" };
const GEM_REASON: Record<Kind, string> = {
  intact: "The box is closed and intact.",
  scuffed: "Only scuffs; the box is closed.",
  dented: "One corner is dented; better to have a person check it.",
  crushed: "The top is caved in.",
  refund: "The box looks intact.",
  battery: "A lithium battery sticker is visible.",
  wet: "A dark wet patch on the side.",
};

function grade(truth: string, action: string | null): H2HSide["outcome"] {
  if (!action) return null;
  const damaged = truth === "hold" || truth === "return";
  if (action === "ship" && damaged) return "near_miss";
  const ok: Record<string, string[]> = { ship: ["ship"], retape: ["retape"], hold: ["hold"], return: ["return"] };
  if (ok[truth]?.includes(action)) return "correct";
  return action === "hold" ? "safe" : "wrong";
}

const BINS: [number, number][] = [[0, 0.6], [0.6, 0.8], [0.8, 0.95], [0.95, 1]];
/** The same scoreboard the server computes (belt/h2h.py scoreboard()), for the replayer only. */
function board(rows: { jev: H2HSide; gemini: H2HSide; agree: boolean }[]): H2HBoard {
  const side = (k: "jev" | "gemini") => {
    const got = rows.map((r) => r[k]);
    const ms = got.map((g) => g.ms ?? 0).sort((a, b) => a - b);
    const n = rows.length;
    const c = (o: string) => got.filter((g) => g.outcome === o).length;
    const cost = got.reduce((a, g) => a + g.cost, 0);
    return {
      parcels: n, answered: n, errors: 0, correct: c("correct"), safe: c("safe"), wrong: c("wrong"), near_miss: c("near_miss"),
      accuracy: n ? c("correct") / n : null,
      ms_mean: n ? Math.round(ms.reduce((a, b) => a + b, 0) / n) : null,
      ms_p95: n ? ms[Math.max(0, Math.ceil(0.95 * n) - 1)] : null,
      tokens_in_mean: n ? Math.round(got.reduce((a, g) => a + (g.tokens_in ?? 0), 0) / n) : null,
      tokens_out_mean: n ? Math.round(got.reduce((a, g) => a + (g.tokens_out ?? 0), 0) / n) : null,
      cost_total: cost, cost_per_1k: n ? (cost / n) * 1000 : null, live_calls: 0,
      mean_p_chosen: n ? got.reduce((a, g) => a + (g.p_chosen ?? 0), 0) / n : null,
    };
  };
  const cal = (k: "jev" | "gemini"): CalibrationBin[] =>
    BINS.map(([lo, hi], i) => {
      const pick = rows.map((r) => r[k]).filter((g) => g.p_chosen != null && g.p_chosen >= lo && (i === BINS.length - 1 ? g.p_chosen <= hi : g.p_chosen < hi));
      const n = pick.length;
      return { lo, hi, n, mean_p: n ? pick.reduce((a, g) => a + (g.p_chosen ?? 0), 0) / n : null, accuracy: n ? pick.filter((g) => g.outcome === "correct").length / n : null };
    });
  const j = side("jev");
  const g = side("gemini");
  const agree = rows.filter((r) => r.agree).length;
  return {
    parcels: rows.length, both_answered: rows.length, agree, agreement_rate: rows.length ? agree / rows.length : null,
    jev: j, gemini: g,
    gemini_wait_s: g.ms_mean != null ? Math.round(g.ms_mean / 10) / 100 : null,
    jev_wait_s: j.ms_mean != null ? Math.round(j.ms_mean) / 1000 : null,
    calibration: { jev: cal("jev"), gemini: cal("gemini") },
    confidence_kind: { jev: "calibrated probability", gemini: "stated by the LLM" },
    prices: MOCK_PRICES,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── a small port of the safety gate (belt/floor.py gate_route), so the mock speaks the same contract ──
const LEGACY = { auto: 0.8, abstain: 0.4 };
const FRAGILE_WORDS = ["glass", "ceramic", "porcelain", "crystal", "mirror", "vase", "wine", "mugs"];
const VALUE_WORDS = ["laptop", "phone", "watch", "headphone", "e-reader", "battery", "drill", "power bank", "lamp"];
const SEV: Record<Lane, number> = { auto: 0, gemini: 1, human: 2 };

export function mockGate(
  choice: string,
  c: number,
  dmg: number,
  risk: number,
  declared: string,
  handling: string,
  t: Thresholds,
  drift: { offset: number; paused: boolean },
) {
  const d = declared.toLowerCase();
  const fragileW = FRAGILE_WORDS.some((w) => d.includes(w));
  const mark = /fragile/i.test(handling);
  const tier = fragileW || mark ? "fragile" : VALUE_WORDS.some((w) => d.includes(w)) ? "high_value" : "standard";
  const base: Record<string, number> = { ship: t.ship ?? t.auto, retape: t.retape ?? 0.85, hold: t.hold ?? 0.5 };
  let bar: number | null = choice in base ? base[choice] : null;
  if (bar !== null && (choice === "ship" || choice === "retape")) bar = Math.min(0.99, bar + drift.offset);
  if (bar !== null && tier === "high_value" && (choice === "ship" || choice === "retape")) bar = Math.min(0.99, bar + 0.05);
  if (bar !== null && tier === "fragile" && choice === "retape") bar = Math.min(0.99, bar + 0.1);
  const intact = choice === "ship" || choice === "retape";
  const checks: GateCheck[] = [
    { rule: "abstain_low_confidence", fired: c < t.abstain, lane: "human", detail: `confidence ${c.toFixed(2)} ${c < t.abstain ? "<" : ">="} abstain ${t.abstain.toFixed(2)}` },
    { rule: "return_never_auto", fired: choice === "return", lane: "gemini", detail: choice === "return" ? "return: irreversible / money, never decided alone" : `${choice} may go auto` },
    { rule: "cross_check_disagree", fired: intact && (dmg >= 0.5 || risk >= 1.2), lane: "gemini", detail: `action ${choice} but P(damaged) ${dmg.toFixed(2)} / risk ${risk.toFixed(2)}` },
    { rule: "marks_vs_declared", fired: intact && mark && !fragileW, lane: "human", detail: mark && !fragileW ? "FRAGILE mark on the box but the declared contents are not fragile: a person checks" : "marks and declared contents agree" },
    { rule: "fragile_no_auto_ship", fired: choice === "ship" && tier === "fragile", lane: "gemini", detail: `tier ${tier}${tier === "fragile" ? ": ship needs a second look" : ""}` },
    { rule: "drift_paused", fired: intact && drift.paused, lane: "gemini", detail: drift.paused ? "audit errors over budget: auto-ship / auto-retape paused" : "auto not paused" },
    bar === null
      ? { rule: "no_bar_for_action", fired: true, lane: "gemini", detail: `no auto bar for '${choice}'` }
      : { rule: `below_${choice}_bar`, fired: c < bar, lane: "gemini", detail: `confidence ${c.toFixed(2)} ${c < bar ? "<" : ">="} ${choice} bar ${bar.toFixed(2)}${tier !== "standard" ? ` (tier ${tier})` : ""}` },
  ];
  const fired = checks.filter((x) => x.fired);
  let lane: Lane = "auto";
  let rule = `auto_${choice}`;
  let reason = `confidence ${c.toFixed(2)} >= ${choice} bar ${bar?.toFixed(2)}, every check passed: Jev decides`;
  if (fired.length) {
    const worst = Math.max(...fired.map((x) => SEV[x.lane]));
    const first = fired.find((x) => SEV[x.lane] === worst)!;
    lane = first.lane;
    rule = first.rule;
    reason = first.detail + (fired.length > 1 ? ` (+${fired.length - 1} more)` : "");
  }
  const legacy: Lane = c >= LEGACY.auto ? "auto" : c >= LEGACY.abstain ? "gemini" : "human";
  return { lane, rule, reason, tier, bar, checks, legacy_lane: legacy };
}

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A drawn parcel (SVG data URI) so the replayer ships no photos. */
export function parcelSvg(kind: Kind, seed: number): string {
  const r = mulberry(seed);
  const hue = 30 + Math.round(r() * 10);
  const body = `hsl(${hue} 42% ${60 + r() * 6}%)`;
  const side = `hsl(${hue} 40% ${48 + r() * 4}%)`;
  const top = `hsl(${hue} 45% ${70 + r() * 4}%)`;
  const tape = "hsl(40 30% 84%)";
  let extra = "";
  let topPath = "M90 120 L230 80 L330 120 L190 160 Z";
  let frontPath = "M90 120 L190 160 L190 290 L90 250 Z";
  if (kind === "dented" || kind === "refund" || kind === "scuffed") {
    if (kind === "dented") extra += `<path d="M120 170 q22 18 4 46" stroke="hsl(${hue} 35% 38%)" stroke-width="5" fill="none" opacity=".6"/>`;
    if (kind === "scuffed") extra += `<path d="M230 210 l40 -12 M236 226 l30 -9" stroke="#fff" stroke-width="3" opacity=".55"/>`;
  }
  if (kind === "crushed") {
    topPath = "M90 150 L210 105 L330 128 L200 182 Z";
    frontPath = "M90 150 L200 182 L190 290 L95 252 Z";
    extra += `<path d="M110 180 l30 18 l-12 22 l26 14 M250 170 l20 30 l-18 16" stroke="hsl(${hue} 35% 30%)" stroke-width="5" fill="none"/>`;
  }
  if (kind === "wet") {
    extra += `<path d="M200 200 q60 -30 110 10 q-10 60 -60 70 q-50 -20 -50 -80 Z" fill="hsl(${hue} 40% 34%)" opacity=".55"/>`;
  }
  if (kind === "battery") {
    extra += `<g transform="translate(232 196) rotate(-12)"><rect width="72" height="52" rx="4" fill="#fff" stroke="#111" stroke-width="3"/><path d="M14 16 h34 v20 h-34 z M48 22 h6 v8 h-6" fill="none" stroke="#111" stroke-width="3"/><path d="M28 18 l-6 10 h8 l-6 10" stroke="#c22" stroke-width="3" fill="none"/></g>`;
  }
  const label = `<g transform="translate(212 170) skewY(-22)"><rect width="74" height="44" fill="#fbfaf7"/><rect x="8" y="8" width="40" height="5" fill="#333"/><rect x="8" y="18" width="56" height="4" fill="#999"/><rect x="8" y="27" width="48" height="4" fill="#999"/></g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 340"><rect width="420" height="340" fill="#e7e5e0"/><rect y="270" width="420" height="70" fill="#cfccc4"/><ellipse cx="210" cy="292" rx="140" ry="16" fill="#000" opacity=".12"/><path d="${frontPath}" fill="${side}"/><path d="M190 160 L330 120 L330 250 L190 290 Z" fill="${body}"/><path d="${topPath}" fill="${top}"/><path d="M160 100 L260 140 L260 150 L160 110 Z" fill="${tape}" opacity=".85"/>${label}${extra}</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

interface CallRec extends InspectRecord {
  call_id: string;
}

export class MockApi implements BeltApi {
  readonly kind = "mock" as const;
  private listeners = new Set<(e: BeltEvent) => void>();
  private thresholds: Thresholds = { auto: 0.9, abstain: 0.4, ship: 0.9, retape: 0.85, hold: 0.5 };
  private drift = { level: 0, offset: 0, paused: false, history: [] as { ts: number; level: number; state: "normal" | "tightened" | "paused"; offset: number; reason: string }[] };
  private routes: Record<string, { lane: Lane; rule: string; tier: string; bar: number | null; legacy_lane: Lane; choice: string; conf: number; truth: string }> = {};
  private audits: Record<string, { parcel_id: string; auto_action: string; status: string; gemini_action?: string; flagged?: boolean; error?: boolean; label?: string; label_source?: string }> = {};
  private rules: Record<string, number> = {};
  private policy: Policy = { options: { ...DEFAULT_OPTIONS }, name: "Standard rules", version: 1 };
  private runId = 0;
  private callSeq = 0;
  private records = new Map<string, CallRec>();
  private pendingHuman = new Map<string, () => void>();
  private humanDecided = 0;
  private proposal: { id: string; rows: PolicyDiffRow[] } | null = null;
  private stats = this.zeroStats();
  private geminiMs: number[] = [];
  private inflight = 0;

  private zeroStats() {
    return {
      parcels: 0,
      lanes: { auto: 0, gemini: 0, human: 0 },
      gemini_skipped: 0,
      jev_ms_avg: 0,
      jev_cost: 0,
      gemini_calls: 0,
      gemini_cost: 0,
      blocked_tools: 0,
      human_pending: 0,
    };
  }

  private driftState(): "normal" | "tightened" | "paused" {
    return this.drift.level >= 2 ? "paused" : this.drift.level === 1 ? "tightened" : "normal";
  }

  private safetyStats() {
    const done = Object.values(this.audits).filter((a) => a.status === "done");
    const errors = done.filter((a) => a.error).length;
    const autos = Object.values(this.routes).filter((r) => r.lane === "auto");
    return {
      audit: {
        rate: 0.2,
        alpha: 0.02,
        started: Object.keys(this.audits).length,
        n: done.length,
        pending: Object.values(this.audits).filter((a) => a.status !== "done").length,
        flagged: done.filter((a) => a.flagged).length,
        errors,
        observed_error: done.length ? errors / done.length : null,
        ucb95: done.length ? Math.min(1, (errors + 3) / (done.length + 3)) : null,
        label_source: "answer key (stands in for the human auditor in this demo)",
      },
      drift: { level: this.drift.level, state: this.driftState(), offset: this.drift.offset, paused: this.drift.paused, history: this.drift.history },
      rules: { ...this.rules },
      auto_key: { n: autos.length, errors: autos.filter((r) => r.choice !== r.truth).length, note: "demo only: the answer key checks every auto parcel; production sees only audits" },
    };
  }

  private emit(e: NoTs<BeltEvent>) {
    const ev = { ...e, ts: Date.now() / 1000 } as BeltEvent;
    for (const l of this.listeners) l(ev);
  }

  private node(node: string, phase: string) {
    this.emit({ type: "adk_node", node, phase });
  }

  private decision: { ms: number; cost: number }[] = [];
  private work: number[] = [];

  private pushStats() {
    const d = this.decision;
    this.emit({
      type: "stats",
      ...this.stats,
      human_pending: this.pendingHuman.size,
      gemini_decision_calls: d.length,
      gemini_decision_ms_avg: d.length ? Math.round(d.reduce((a, b) => a + b.ms, 0) / d.length) : null,
      gemini_decision_cost: d.reduce((a, b) => a + b.cost, 0),
      gemini_work_calls: this.work.length,
      gemini_work_cost: this.work.reduce((a, b) => a + b, 0),
      safety: this.safetyStats(),
    });
  }

  subscribe(onEvent: (e: BeltEvent) => void, onStatus: (s: StreamStatus) => void) {
    this.listeners.add(onEvent);
    setTimeout(() => onStatus("open"), 50);
    return () => {
      this.listeners.delete(onEvent);
    };
  }

  private newCall(prefix: string) {
    this.callSeq += 1;
    return `${prefix}${String(this.callSeq).padStart(4, "0")}`;
  }

  private jevReading(spec: Spec): { probs: Record<string, number>; action: string; confidence: number; damaged: number; risk: number } {
    const taught = this.policy.options.hold.includes("battery");
    const table: Record<Kind, [Record<string, number>, number, number]> = {
      intact: [{ ship: 0.94, retape: 0.03, hold: 0.02, return: 0.01 }, 0.93, 0.04],
      scuffed: [{ ship: 0.84, retape: 0.12, hold: 0.03, return: 0.01 }, 0.84, 0.12],
      dented: [{ ship: 0.28, retape: 0.58, hold: 0.12, return: 0.02 }, 0.58, 0.55],
      crushed: [{ ship: 0.02, retape: 0.08, hold: 0.86, return: 0.04 }, 0.71, 0.88],
      refund: [{ ship: 0.71, retape: 0.2, hold: 0.06, return: 0.03 }, 0.66, 0.08],
      battery: taught
        ? [{ ship: 0.04, retape: 0.02, hold: 0.92, return: 0.02 }, 0.91, 0.05]
        : [{ ship: 0.36, retape: 0.18, hold: 0.33, return: 0.13 }, 0.31, 0.06],
      wet: [{ ship: 0.22, retape: 0.18, hold: 0.41, return: 0.19 }, 0.34, 0.47],
    };
    const [probs, confidence, damaged] = table[spec.kind];
    const action = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    return { probs: { ...probs }, action, confidence, damaged, risk: Math.round(damaged * 160) / 100 };
  }

  async run(req: RunRequest) {
    const id = ++this.runId;
    this.stats = this.zeroStats();
    this.geminiMs = [];
    this.decision = [];
    this.work = [];
    this.pendingHuman.clear();
    this.humanDecided = 0;
    this.proposal = null;
    this.routes = {};
    this.audits = {};
    this.rules = {};
    this.drift = { level: 0, offset: 0, paused: false, history: [] };
    this.policy = { options: { ...DEFAULT_OPTIONS }, name: "Standard rules", version: 1 };
    const limit = Math.min(req.limit || SCRIPT.length, SCRIPT.length);
    const pace = req.pace === undefined ? 1 : req.pace;
    const gap = Math.max(260, pace * 1000);
    void (async () => {
      this.emit({
        type: "run_start",
        mode: req.mode,
        total: limit,
        thresholds: this.thresholds,
        policy_version: this.policy.version,
        credit: "Parcel drawings generated in the browser (mock replay, no photos)",
        jev_model: "jev-1.14.0",
        gemini_model: "gemini-3.5-flash-lite (mock)",
        prices: MOCK_PRICES,
      });
      this.emit({ type: "policy_version", version: this.policy.version!, policy: this.policy });
      if (req.mode === "h2h") {
        await this.headToHead(limit, gap, id);
        return;
      }
      this.node("enter", "start");
      await sleep(120);
      this.node("enter", "end");
      for (let i = 0; i < limit; i++) {
        if (id !== this.runId) return;
        void this.oneParcel(SCRIPT[i], i, limit, req.mode, id);
        await sleep(gap);
      }
      while (this.inflight > 0 && id === this.runId) await sleep(200);
      if (id !== this.runId) return;
      await this.shiftReport(id);
    })();
    return { ok: true };
  }

  private async oneParcel(spec: Spec, i: number, total: number, mode: string, id: number) {
    const pid = `P-${String(101 + i).padStart(4, "0")}`;
    this.inflight += 1;
    const photo = parcelSvg(spec.kind, i + 7);
    this.emit({
      type: "parcel",
      parcel_id: pid,
      photo_url: photo,
      declared: { text: spec.declared, fragile: !!spec.fragile },
      index: i + 1,
      total,
    });
    this.node("tick", "start");
    const ms = Math.round(84 + Math.random() * 46);
    await sleep(ms);
    const reading = this.jevReading(spec);
    const callId = this.newCall("j");
    const tokensIn = 1130 + Math.round(Math.random() * 40);
    const cost = (tokensIn / 1e6) * 0.042;
    this.records.set(callId, {
      call_id: callId,
      kind: "jev",
      model: "jev-1.14.0",
      live: false,
      ms,
      parcel: pid,
      note: "mock replay: no network call was made",
      request: {
        method: "POST",
        model: "jev-1.14.0",
        policy_version: this.policy.version,
        declared: spec.declared,
        image: "<parcel drawing, 420x340 SVG>",
        options: this.policy.options,
      },
      response: { probabilities: reading.probs, usage: { input_tokens: tokensIn, output_tokens: 0 } },
    });
    this.stats.parcels += 1;
    this.stats.jev_cost += cost;
    this.stats.jev_ms_avg = this.stats.jev_ms_avg + (ms - this.stats.jev_ms_avg) / this.stats.parcels;
    this.emit({
      type: "jev_call",
      call_id: callId,
      parcel_id: pid,
      ms,
      tokens_in: tokensIn,
      tokens_out: 0,
      cost,
      live: false,
      probabilities: reading.probs,
      confidence: reading.confidence,
      action: reading.action,
      policy_version: this.policy.version,
      model_choice: reading.action,
      damaged: reading.damaged,
      risk: reading.risk,
    });
    this.node("tick", "end");
    this.node("gate", "start");
    const t = this.thresholds;
    void mode;
    const handling = spec.fragile ? "FRAGILE mark on the box" : "";
    const g = mockGate(reading.action, reading.confidence, reading.damaged, reading.risk, spec.declared, handling, t, this.drift);
    const lane: Lane = g.lane;
    const reason = g.reason;
    this.routes[pid] = { lane, rule: g.rule, tier: g.tier, bar: g.bar, legacy_lane: g.legacy_lane, choice: reading.action, conf: reading.confidence, truth: TRUTH[spec.kind] };
    this.rules[g.rule] = (this.rules[g.rule] ?? 0) + 1;
    this.stats.lanes[lane] += 1;
    this.emit({
      type: "route", parcel_id: pid, lane, reason, confidence: reading.confidence, thresholds: { ...t },
      rule: g.rule, tier: g.tier, bar: g.bar, checks: g.checks, legacy_lane: g.legacy_lane, legacy_reason: `old gate: ${g.legacy_lane}`,
      drift: this.driftState(),
    });
    this.node("gate", "end");

    const humanInfo = {
      truth: TRUTH[spec.kind],
      photo_url: photo, declared: spec.declared, jev_action: reading.action, confidence: reading.confidence,
      rule: g.rule, tier: g.tier, checks: g.checks, legacy_lane: g.legacy_lane, damaged: reading.damaged, risk: reading.risk,
      probabilities: reading.probs, handling,
    };
    if (lane === "auto") {
      this.emit({ type: "decision", parcel_id: pid, final_action: reading.action, decided_by: "jev" });
      if (i % 4 === 0) {
        // audit sample: a shadow second look on an auto parcel; the decision stands
        this.audits[pid] = { parcel_id: pid, auto_action: reading.action, status: "running" };
        this.emit({ type: "audit", phase: "start", parcel_id: pid, auto_action: reading.action, rate: 0.2 });
        this.pushStats();
        await sleep(1400);
        const wrong = reading.action !== TRUTH[spec.kind];
        const gem = GEM_PICK[spec.kind];
        const flagged = gem !== reading.action;
        this.audits[pid] = { ...this.audits[pid], status: "done", gemini_action: gem, flagged, error: wrong, label: TRUTH[spec.kind], label_source: "answer key (stands in for the human auditor in this demo)" };
        this.emit({ type: "audit", phase: "done", parcel_id: pid, auto_action: reading.action, gemini_action: gem, gemini_reason: GEM_REASON[spec.kind], flagged, error: wrong, label: TRUTH[spec.kind], label_source: "answer key (stands in for the human auditor in this demo)" });
        if (flagged) {
          this.emit({ type: "human_queue", parcel_id: pid, reason: `audit: Jev auto-${reading.action}, Gemini says ${gem} (shadow review, belt did not wait)`, kind: "audit", auto_action: reading.action, second_look: { action: gem, reason: GEM_REASON[spec.kind], needs_human: false }, ...humanInfo });
        }
        if (wrong && this.drift.level < 2) {
          this.drift.level += 1;
          this.drift.offset = 0.05;
          this.drift.paused = this.drift.level >= 2;
          const n = Object.values(this.audits).filter((a) => a.status === "done").length;
          const errors = Object.values(this.audits).filter((a) => a.error).length;
          const ev = { level: this.drift.level, state: this.driftState(), offset: this.drift.offset, errors, n, alpha: 0.02, parcel_id: pid, reason: `${errors} audited auto-lane mistake(s) in ${n} audits > budget 2%: ${this.drift.level === 1 ? "bars +0.05" : "auto-ship paused"}` };
          this.drift.history.push({ ts: Date.now() / 1000, level: ev.level, state: ev.state, offset: ev.offset, reason: ev.reason });
          this.emit({ type: "drift", ...ev });
        }
      } else {
        this.stats.gemini_skipped += 1;
        this.emit({ type: "gemini_skipped", parcel_id: pid, saved_ms_est: 2100, saved_cost_est: 0.0011, lane: "auto", basis: "estimate: mock prior" });
      }
      this.pushStats();
    } else if (lane === "human") {
      this.stats.gemini_skipped += 1;
      this.emit({ type: "gemini_skipped", parcel_id: pid, saved_ms_est: 2100, saved_cost_est: 0.0011, lane: "human", basis: "estimate: mock prior" });
      this.emit({ type: "human_queue", parcel_id: pid, reason, kind: "decide", ...humanInfo });
      this.emit({ type: "decision", parcel_id: pid, final_action: "hold", decided_by: "code" });
      this.pushStats();
      await new Promise<void>((resolve) => this.pendingHuman.set(pid, resolve));
      this.pushStats();
    } else {
      this.pushStats();
      const verdict = await this.llm("second_look", pid, spec, reading, id);
      let final = verdict;
      if (spec.kind === "crushed" || spec.kind === "refund") {
        final = await this.claim(pid, spec, reading, id);
      }
      this.emit({ type: "decision", parcel_id: pid, final_action: final, decided_by: final === verdict ? "gemini" : "code" });
      this.pushStats();
    }
    this.inflight -= 1;
  }

  // ── mode 2: Jev vs Gemini, same parcel, same question (mock numbers, marked REPLAY) ──
  private async headToHead(limit: number, gap: number, id: number) {
    const rows: { jev: H2HSide; gemini: H2HSide; agree: boolean }[] = [];
    this.node("h2h_enter", "start");
    this.node("h2h_enter", "end");
    for (let i = 0; i < limit; i++) {
      if (id !== this.runId) return;
      await sleep(Math.min(gap, 400));
      const spec = SCRIPT[i];
      const pid = `P-${String(101 + i).padStart(4, "0")}`;
      const truth = TRUTH[spec.kind];
      this.emit({ type: "parcel", parcel_id: pid, photo_url: parcelSvg(spec.kind, i + 7), declared: { text: spec.declared, fragile: !!spec.fragile }, index: i + 1, total: limit });
      this.node("h2h_tick", "start");
      const reading = this.jevReading(spec);
      const jevMs = Math.round(90 + Math.random() * 50);
      const gemMs = Math.round(1200 + Math.random() * 1400);
      const gCall = this.newCall("g");
      this.emit({ type: "llm_start", call_id: gCall, agent: "gemini_reflex", job: "decision", parcel_id: pid });
      this.node("gemini_reflex", "start");
      const jevP = (async () => {
        await sleep(jevMs);
        const jCall = this.newCall("j");
        const probs = reading.probs;
        const side: H2HSide = {
          call_id: jCall, action: reading.action, probabilities: probs, p_chosen: probs[reading.action], confidence: reading.confidence,
          ms: jevMs, tokens_in: 1150, tokens_out: 20, cost: (1150 / 1e6) * MOCK_PRICES.jev_in_per_m, live: false, model: "jev-1.14.0",
          outcome: grade(truth, reading.action),
        };
        this.records.set(jCall, { call_id: jCall, kind: "jev", model: "jev-1.14.0", live: false, ms: jevMs, parcel: pid, note: "mock replay: no network call was made", response: { probabilities: probs } });
        if (id === this.runId) this.emit({ type: "h2h_answer", side: "jev", parcel_id: pid, ...side });
        return side;
      })();
      const gemP = (async () => {
        await sleep(gemMs);
        const action = GEM_PICK[spec.kind];
        const probs: Record<string, number> = { ship: 0.03, retape: 0.03, hold: 0.03, return: 0.03 };
        probs[action] = 0.91;
        const tin = 1740, tout = 95;
        const side: H2HSide = {
          call_id: gCall, action, probabilities: probs, p_chosen: 0.95, confidence: 0.95, reason: GEM_REASON[spec.kind],
          ms: gemMs, tokens_in: tin, tokens_out: tout, thought_tokens: 0,
          cost: (tin * MOCK_PRICES.gemini_in_per_m + tout * MOCK_PRICES.gemini_out_per_m) / 1e6, live: false, model: "gemini-3.5-flash-lite (mock)",
          outcome: grade(truth, action),
        };
        this.records.set(gCall, { call_id: gCall, kind: "gemini", agent: "gemini_reflex", model: "gemini-3.5-flash-lite (mock)", live: false, ms: gemMs, parcel: pid, note: "mock replay: no network call was made", response: { text: JSON.stringify({ action, probabilities: probs, confidence: 0.95, reason: side.reason }) } });
        if (id === this.runId) {
          this.emit({ type: "llm_end", call_id: gCall, agent: "gemini_reflex", job: "decision", ms: gemMs, tokens_in: tin, tokens_out: tout, cost: side.cost, live: false, output: { action, confidence: 0.95 } });
          this.node("gemini_reflex", "end");
          this.emit({ type: "h2h_answer", side: "gemini", parcel_id: pid, ...side });
        }
        return side;
      })();
      const [j, g] = await Promise.all([jevP, gemP]);
      if (id !== this.runId) return;
      const agree = j.action === g.action;
      rows.push({ jev: j, gemini: g, agree });
      this.emit({ type: "h2h_result", parcel_id: pid, declared: spec.declared, truth, jev: j, gemini: g, agree });
      this.emit({ type: "h2h_stats", ...board(rows) });
      this.node("h2h_tick", "end");
    }
    this.node("h2h_finish", "start");
    this.emit({ type: "run_end", scorecard: board(rows) as unknown as Record<string, unknown>, report: null });
    this.node("h2h_finish", "end");
  }

  private async stream(callId: string, text: string, id: number) {
    const words = text.split(/(\s+)/);
    let buf = "";
    for (let k = 0; k < words.length; k++) {
      if (id !== this.runId) return;
      buf += words[k];
      if (buf.length > 14 || k === words.length - 1) {
        this.emit({ type: "llm_delta", call_id: callId, text: buf });
        buf = "";
        await sleep(55 + Math.random() * 40);
      }
    }
  }

  private async llm(
    agent: Agent,
    pid: string | undefined,
    spec: Spec | null,
    reading: { action: string; confidence: number; damaged: number } | null,
    id: number,
    textOverride?: string,
    output?: unknown,
  ): Promise<string> {
    const callId = this.newCall("g");
    this.node(agent, "start");
    const t0 = performance.now();
    this.emit({ type: "llm_start", call_id: callId, agent, job: JOB[agent], parcel_id: pid });
    let action = reading?.action ?? "hold";
    if (spec?.kind === "dented") action = "retape";
    if (spec?.kind === "crushed") action = "hold";
    const text =
      textOverride ??
      `{"verdict": "${action}", "reason": "${
        spec?.kind === "dented"
          ? "One corner is dented but the tape holds and nothing is torn. Retape and send on."
          : spec?.kind === "crushed"
            ? "The top is caved in and the contents are fragile. Hold it and open a claim."
            : spec?.kind === "refund"
              ? "The box looks intact. The customer note asks for a refund for a damaged item."
              : "The box looks fine on a second look."
      }", "agrees_with_jev": ${action === reading?.action}}`;
    await this.stream(callId, text, id);
    const ms = Math.round(performance.now() - t0);
    const tokensIn = 1800 + Math.round(Math.random() * 300);
    const tokensOut = Math.round(text.length / 3.6);
    const cost = tokensIn * 3e-7 + tokensOut * 2.5e-6;
    this.stats.gemini_calls += 1;
    this.stats.gemini_cost += cost;
    this.geminiMs.push(ms);
    let out: unknown = output;
    if (out === undefined) {
      try {
        out = JSON.parse(text);
      } catch {
        out = text;
      }
    }
    this.records.set(callId, {
      call_id: callId,
      kind: "gemini",
      agent,
      model: "gemini-flash (mock)",
      live: false,
      ms,
      parcel: pid,
      note: "mock replay: no network call was made",
      request: {
        agent,
        instruction: `You are the ${agent} agent on a parcel sorting belt.`,
        input: pid ? { parcel_id: pid, declared: spec?.declared, jev: reading } : { shift: "end" },
      },
      response: { text, usage: { input_tokens: tokensIn, output_tokens: tokensOut } },
    });
    if (JOB[agent] === "decision") this.decision.push({ ms, cost });
    else this.work.push(cost);
    this.emit({
      type: "llm_end",
      call_id: callId,
      agent,
      job: JOB[agent],
      ms,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost,
      live: false,
      output: out,
    });
    this.node(agent, "end");
    return action;
  }

  private async claim(
    pid: string,
    spec: Spec,
    reading: { action: string; confidence: number; damaged: number },
    id: number,
  ): Promise<string> {
    const refund = spec.kind === "refund";
    const tool = refund ? "issue_refund" : "file_claim";
    const args = refund
      ? { parcel_id: pid, amount_usd: 89.0, reason: "customer reports damage" }
      : { parcel_id: pid, damage: "crushed top", fragile: !!spec.fragile, contents: spec.declared };
    const text = refund
      ? `Customer says the item arrived damaged. Proposing ${tool}(${JSON.stringify(args)}).`
      : `ClaimPacket ready: crushed top, fragile contents. Proposing ${tool}(${JSON.stringify(args)}).`;
    this.node("read_label", "start");
    await sleep(60);
    this.node("read_label", "end");
    const callId = this.newCall("g");
    this.node("claims_clerk", "start");
    this.emit({ type: "llm_start", call_id: callId, agent: "claims_clerk", job: "clerk", parcel_id: pid });
    const t0 = performance.now();
    await this.stream(callId, text, id);
    const ms = Math.round(performance.now() - t0);
    const tokensIn = 2100;
    const tokensOut = 90;
    const cost = tokensIn * 3e-7 + tokensOut * 2.5e-6;
    this.stats.gemini_calls += 1;
    this.stats.gemini_cost += cost;
    this.work.push(cost);
    this.records.set(callId, {
      call_id: callId,
      kind: "gemini",
      agent: "claims_clerk",
      model: "gemini-flash (mock)",
      live: false,
      ms,
      parcel: pid,
      note: "mock replay: no network call was made",
      request: { agent: "claims_clerk", tools: ["file_claim", "issue_refund"], parcel_id: pid },
      response: { text, function_call: { name: tool, args } },
    });
    this.emit({
      type: "llm_end",
      call_id: callId,
      agent: "claims_clerk",
      job: "clerk",
      ms,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost,
      live: false,
      output: { function_call: { name: tool, args } },
    });
    this.node("claims_clerk", "end");
    this.emit({ type: "tool_proposed", call_id: callId, agent: "claims_clerk", tool, args });
        await sleep(160);
    const allowed = reading.damaged >= 0.6;
    if (!allowed) this.stats.blocked_tools += 1;
    this.emit({
      type: "guard_verdict",
      call_id: callId,
      allowed,
      rule: refund
        ? "issue_refund needs Jev damaged ≥ 0.60 on this parcel"
        : "file_claim needs Jev damaged ≥ 0.60 and a complete ClaimPacket",
      evidence: { jev_damaged: reading.damaged, jev_action: reading.action, jev_confidence: reading.confidence },
    });
    if (allowed) {
      this.node("claim_ready", "start");
      this.node("claim_ready", "end");
    }
    return allowed ? (refund ? "return" : "file_claim") : "hold";
  }

  private async shiftReport(id: number) {
    this.node("summarise", "start");
    this.node("summarise", "end");
    const s = this.stats;
    const text = `Shift done. ${s.parcels} parcels: Jev decided ${s.lanes.auto} alone, Gemini took a second look at ${s.lanes.gemini}, and ${s.lanes.human} went to the desk. The gate blocked ${s.blocked_tools} tool call(s).`;
    await this.llm("shift_lead", undefined, null, null, id, text, text);
    this.node("finish", "end");
    this.emit({
      type: "run_end",
      scorecard: {
        parcels: s.parcels,
        gemini_skipped: s.gemini_skipped,
        blocked_tools: s.blocked_tools,
        jev_ms_avg: Math.round(s.jev_ms_avg),
        gemini_decision_calls: this.decision.length,
        gemini_decision_ms_avg: this.decision.length ? Math.round(this.decision.reduce((a, b) => a + b.ms, 0) / this.decision.length) : 0,
        gemini_work_calls: this.work.length,
        jev_cost: s.jev_cost,
        gemini_decision_cost: this.decision.reduce((a, b) => a + b.cost, 0),
        gemini_work_cost: this.work.reduce((a, b) => a + b, 0),
      },
      report: { headline: "End of shift", report: text },
    });
  }

  async stop() {
    this.runId++;
    this.inflight = 0;
    for (const r of this.pendingHuman.values()) r();
    this.pendingHuman.clear();
    return { ok: true };
  }
  async getThresholds() {
    return { ...this.thresholds };
  }
  async setThresholds(t: Thresholds) {
    const ship = t.ship ?? t.auto;
    this.thresholds = { ...this.thresholds, auto: ship, ship, abstain: Math.min(t.abstain, ship) };
    return { ...this.thresholds };
  }
  async getSafety(): Promise<SafetyState> {
    const t = this.thresholds;
    const eff = { abstain: t.abstain, ship: Math.min(0.99, (t.ship ?? t.auto) + this.drift.offset), retape: Math.min(0.99, (t.retape ?? 0.85) + this.drift.offset), hold: t.hold ?? 0.5, paused: this.drift.paused };
    return {
      thresholds: { ...t, ship: t.ship ?? t.auto, retape: t.retape ?? 0.85, hold: t.hold ?? 0.5 },
      effective: eff,
      source: "mock: design values",
      floors: { ship: 0.8, retape: 0.7, hold: 0.4 },
      legacy: { ...LEGACY },
      never_auto: ["return", "file_claim", "issue_refund"],
      params: { cross_damaged: 0.5, cross_risk: 1.2, fragile_retape_bump: 0.1, high_value_bump: 0.05, tighten_step: 0.05 },
      config: { audit_rate: 0.2, alpha: 0.02 },
      ...this.safetyStats(),
      audits: Object.values(this.audits),
      routes: Object.fromEntries(Object.entries(this.routes).map(([k, r]) => [k, { lane: r.lane, rule: r.rule, tier: r.tier, bar: r.bar, legacy_lane: r.legacy_lane }])),
      calibration: {
        source: "mock (no calibration run)",
        n: 24,
        alpha: 0.02,
        per_action: {
          ship: { n_choice: 12, data_bar: 0.84, floor: 0.8, in_force: 0.9, covered: 6, errors: 0, risk: 0, ucb95: 0.393 },
          retape: { n_choice: 3, data_bar: 0.58, floor: 0.7, in_force: 0.85, covered: 0, errors: 0, risk: null, ucb95: null },
          hold: { n_choice: 9, data_bar: 0.34, floor: 0.4, in_force: 0.5, covered: 4, errors: 0, risk: 0, ucb95: 0.527 },
        },
        in_force: { ship: 0.9, retape: 0.85, hold: 0.5 },
        gate: { lanes: { auto: 8, gemini: 10, human: 6 }, coverage: 0.333, auto_errors: 0, auto_error_rate: 0, auto_ucb95: 0.312 },
        legacy: { auto: 10, coverage: 0.417, auto_errors: 1 },
        n_needed_for_alpha: 149,
        note: "Mock numbers. With 0 mistakes in n covered parcels the 95% upper bound is about 3/n; a 2% claim needs about 149 covered parcels per action.",
      },
    };
  }
  async setSafety(body: Record<string, unknown>) {
    if (body.reset_drift) {
      this.drift = { ...this.drift, level: 0, offset: 0, paused: false, history: [...this.drift.history, { ts: Date.now() / 1000, level: 0, state: "normal", offset: 0, reason: "reset by a person" }] };
      this.emit({ type: "drift", level: 0, state: "normal", offset: 0, reason: "reset by a person" });
    }
    return this.getSafety();
  }
  async youJev(ids: string[]): Promise<YouJevResult> {
    await sleep(300);
    const answers = ids.map((id) => {
      const i = Number(id.slice(2)) - 101;
      const spec = SCRIPT[i];
      const r = this.jevReading(spec);
      const g = mockGate(r.action, r.confidence, r.damaged, r.risk, spec.declared, spec.fragile ? "FRAGILE" : "", this.thresholds, { offset: 0, paused: false });
      return { id, choice: r.action, action: r.action, confidence: r.confidence, probabilities: r.probs, damaged: r.damaged, risk: r.risk, outcome: grade(TRUTH[spec.kind], r.action) ?? undefined, truth: TRUTH[spec.kind], lane: g.lane, rule: g.rule, live: false, ms: 100 + (i % 5) * 9 };
    });
    const c = (k: string) => answers.filter((a) => a.outcome === k).length;
    return {
      source: "replay",
      source_label: "mock replayer: Jev answers built in the browser, no request sent",
      answers,
      summary: { n: answers.length, correct: c("correct"), safe: c("safe"), wrong: c("wrong"), near_miss: c("near_miss"), ms_avg: 110, errors: 0 },
    };
  }
  async getPolicy() {
    return structuredClone(this.policy);
  }
  async setPolicy(body: { options?: Record<string, string>; preset?: string; name?: string }) {
    if (body.options) {
      this.policy = {
        options: { ...this.policy.options, ...body.options },
        name: body.name || "Edited by hand",
        version: (this.policy.version || 1) + 1,
      };
      this.emit({ type: "policy_version", version: this.policy.version!, policy: this.policy });
    }
    return structuredClone(this.policy);
  }
  async decideHuman(parcelId: string, action: string) {
    const r = this.pendingHuman.get(parcelId);
    if (!r && this.audits[parcelId]) {
      const a = this.audits[parcelId];
      this.audits[parcelId] = { ...a, label: action, label_source: "person", error: action !== a.auto_action };
      this.emit({ type: "human_decided", parcel_id: parcelId, action, kind: "audit", audit_error: action !== a.auto_action });
      this.pushStats();
      return { ok: true };
    }
    if (!r) return { ok: false };
    this.pendingHuman.delete(parcelId);
    this.emit({ type: "human_decided", parcel_id: parcelId, action });
    this.emit({ type: "decision", parcel_id: parcelId, final_action: action, decided_by: "human" });
    r();
    this.humanDecided += 1;
    if (this.humanDecided === 2 && !this.proposal) void this.teachRun();
    return { ok: true };
  }
  async teachRun() {
    const id = this.runId;
    const rows: PolicyDiffRow[] = [{ option: "hold", before: this.policy.options.hold, after: TAUGHT_HOLD }];
    const pid = `T-${String(this.callSeq + 1).padStart(3, "0")}`;
    const text =
      "Two held parcels carried a lithium battery sticker and the desk held both. The policy never mentions " +
      "batteries, so Jev split its vote. Proposal: name the sticker in the hold option.";
    await this.llm("teacher", undefined, null, null, id, text, { proposal: rows });
    this.proposal = { id: pid, rows };
    this.emit({
      type: "teach_proposal",
      proposal_id: pid,
      diff: rows,
      diff_text: rows.map((r) => `- ${r.option}: ${r.before}\n+ ${r.option}: ${r.after}`).join("\n"),
      rationale: text,
      parcel_ids: ["P-0103", "P-0110"],
      rule_text: "A box with a lithium battery sticker is held for a person.",
      evidence: MOCK_EVIDENCE,
      status: "proposed",
    });
    return { ok: true, proposal_id: pid };
  }
  async teachRejudge(proposalId: string): Promise<RejudgeResult> {
    await sleep(500);
    // the honest picture: the answers get better, but one is still too unsure to leave the desk
    const rows: RejudgeRow[] = MOCK_EVIDENCE.map((e, i) => {
      const leaves = i === 0;
      return {
        ...e,
        before: { action: i === 0 ? "ship" : "hold", confidence: i === 0 ? 0.33 : 0.31, live: false, lane: "human", rule: "abstain_low_confidence", checks: ["abstain_low_confidence"] },
        after: leaves
          ? { action: "hold", confidence: 0.62, live: false, lane: "gemini", rule: "below_hold_bar", checks: ["below_hold_bar"] }
          : { action: "hold", confidence: 0.36, live: false, lane: "human", rule: "abstain_low_confidence", checks: ["abstain_low_confidence"] },
        live: false,
        match_before: i !== 0,
        match_after: true,
        leaves_desk: leaves,
        still_person_reason: leaves ? null : "right answer, but confidence 0.36 is under the 0.40 desk bar",
      };
    });
    const left = rows.filter((r) => r.leaves_desk).length;
    return { proposal_id: proposalId, version_before: 1, version_after: this.policy.version ?? 2, rows, matches_before: rows.length - 1, matches_after: rows.length, left_desk_before: 0, left_desk_after: left, desk_bar: 0.4, k: rows.length };
  }
  async getHuman() {
    return { pending: [] as HumanItem[], decided: [] as HumanItem[] };
  }
  async getTeach() {
    return { proposals: [] as ProposalPublic[] };
  }
  async teachApprove(proposalId: string) {
    if (!this.proposal || this.proposal.id !== proposalId) return { ok: false };
    const opts = { ...this.policy.options };
    for (const r of this.proposal.rows) opts[r.option] = r.after;
    this.policy = { options: opts, name: "Taught: battery sticker -> hold", version: (this.policy.version || 1) + 1 };
    this.emit({ type: "teach_approved", proposal_id: proposalId, version: this.policy.version! });
    this.emit({ type: "policy_version", version: this.policy.version!, policy: this.policy });
    return { ok: true, version: this.policy.version };
  }
  async contextTest(body: { photo?: string; a: string; b: string }): Promise<ContextResult> {
    await sleep(240);
    const glass = (s: string) => /glass|vase|ceramic|fragile/i.test(s);
    const side = (tag: string, declared: string) => {
      const callId = this.newCall("j");
      const probs = glass(declared)
        ? { ship: 0.08, retape: 0.11, hold: 0.79, return: 0.02 }
        : { ship: 0.21, retape: 0.71, hold: 0.06, return: 0.02 };
      const action = glass(declared) ? "hold" : "retape";
      this.records.set(callId, {
        call_id: callId,
        kind: "jev",
        model: "jev-1.14.0",
        live: false,
        ms: 101,
        note: "mock replay: no network call was made",
        request: { declared, image: "<same dented parcel>", options: this.policy.options },
        response: { probabilities: probs },
      });
      return { tag, declared, call_id: callId, ms: 101, probabilities: probs, decision: { action, confidence: Math.max(...Object.values(probs)) } };
    };
    const sides = [side("A", body.a), side("B", body.b)];
    return { photo: "DEMO-DENTED", url: parcelSvg("dented", 3), sides, different: sides[0].decision.action !== sides[1].decision.action };
  }
  async inspect(callId: string): Promise<InspectRecord> {
    const r = this.records.get(callId);
    if (!r) throw new Error("no such call");
    return r;
  }
  async manifest() {
    return { parcels: SCRIPT.map((sp, i) => ({ id: `P-${String(101 + i).padStart(4, "0")}`, url: parcelSvg(sp.kind, i + 7), declared: sp.declared })) };
  }
  async judge(id: string, action: string): Promise<JudgeResult> {
    const spec = SCRIPT[Number(id.slice(2)) - 101];
    const truth = spec ? TRUTH[spec.kind] : "ship";
    if (action === "missed") return { id, action, truth, outcome: truth === "hold" || truth === "return" ? "near_miss" : "missed" };
    return { id, action, truth, outcome: grade(truth, action) ?? "wrong" };
  }
  async photoCredit() {
    return "Parcel drawings generated in the browser (mock replay, no photos)";
  }
}
