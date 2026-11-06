// One reducer folds the server's event stream into page state. Nothing here invents numbers:
// every count, latency and cost comes from an event (stats, jev_call, llm_end, gemini_skipped).
import type {
  Agent,
  BeltEvent,
  ClaimPacketEv,
  Declared,
  DriftState,
  GateCheck,
  GuardVerdictEv,
  SecondLookVerdict,
  H2HBoard,
  H2HPrices,
  H2HSide,
  HumanItem,
  Job,
  Lane,
  Mode,
  Policy,
  ProposalPublic,
  RejudgeResult,
  Stats,
  TeachProposalEv,
  Thresholds,
  ToolProposedEv,
} from "./types";

export interface ParcelState {
  id: string;
  photo_url: string;
  declared: string;
  fragile: boolean;
  index: number;
  total: number;
  ts: number;
  jev?: {
    call_id: string;
    ms: number;
    cost: number;
    live: boolean;
    probabilities: Record<string, number>;
    confidence: number;
    action: string;
    tokens_in: number;
    policy_version?: number;
    model_choice?: string;
    damaged?: number;
    risk?: number;
    why?: string;
  };
  lane?: Lane;
  /** safety gate: the rule that picked the lane, the tier, every check, the old gate's lane */
  rule?: string;
  tier?: string;
  bar?: number | null;
  checks?: GateCheck[];
  legacyLane?: Lane;
  escalatedFrom?: Lane;
  humanKind?: "decide" | "audit";
  secondLook?: SecondLookVerdict | null;
  handling?: string;
  autoAction?: string | null;
  audit?: { status: "running" | "done"; gemini_action?: string | null; gemini_reason?: string | null; flagged?: boolean; error?: boolean; label?: string | null; label_source?: string | null };
  laneTs?: number;
  reason?: string;
  geminiSkipped?: boolean;
  final?: string;
  decidedBy?: string;
  decidedTs?: number;
  firstDecidedTs?: number;
  humanReason?: string;
  humanAction?: string;
  /** the answer key, sent with desk items for the presenter chip */
  truth?: string | null;
  policyVersion: number;
  geminiCallIds: string[];
}

export interface CallState {
  call_id: string;
  kind: "jev" | "llm";
  agent?: Agent;
  job?: Job;
  jobLabel?: string;
  parcel_id?: string;
  start: number;
  end?: number;
  ms?: number;
  live?: boolean;
  text: string;
  thought?: string;
  output?: unknown;
  cost?: number;
  tokens_in?: number;
  tokens_out?: number;
}

export interface ToolState {
  call_id: string;
  proposed: ToolProposedEv;
  verdict?: GuardVerdictEv;
  parcel_id?: string;
}

/** One claim form in mode 3: the label Gemini read, the packet it wrote, the gate and the result. */
export interface ClaimCard {
  parcel_id: string;
  url: string;
  scan: number;
  declared?: string;
  reading: boolean;
  packet?: ClaimPacketEv;
  tool?: ToolState;
}

export interface ProposalState extends Omit<TeachProposalEv, "status"> {
  status: "pending" | "approving" | "approved" | "no_change";
  approvedVersion?: number;
}

/** The caption bar under the ADK graph (A6): the latest graph step in plain words. */
export interface Caption {
  parcel_id: string;
  k: number;
  n: number;
  node: string;
  text: string;
  walk: boolean;
  pause_s: number;
  ts: number;
}

export interface NodeState {
  phase: string;
  ts: number;
  count: number;
}

/** Mode 2: one parcel, both answers side by side. */
export interface H2HRow {
  id: string;
  jev?: H2HSide;
  gemini?: H2HSide;
  gemma?: H2HSide;
  truth?: string;
  agree?: boolean;
  done: boolean;
}

export interface H2HState {
  rows: Record<string, H2HRow>;
  order: string[];
  board?: H2HBoard;
  prices?: H2HPrices;
  geminiModel?: string;
  jevModel?: string;
  /** set when the server runs the third side (belt/gemma.py) */
  gemmaModel?: string | null;
}

export const AGENT_JOB: Record<string, Job> = {
  second_look: "decision",
  gemini_reflex: "decision",
  claims_clerk: "clerk",
  shift_lead: "report",
  teacher: "teacher",
};
export const JOB_LABEL: Record<Job, string> = {
  decision: "2nd look (decision on unsure parcels)",
  clerk: "clerk (reads label → claim)",
  report: "report",
  teacher: "teacher",
};
export function jobOf(c: { job?: Job; agent?: string }): Job {
  return c.job ?? AGENT_JOB[c.agent ?? ""] ?? "clerk";
}

export interface State {
  streamStatus: "connecting" | "open" | "error";
  running: boolean;
  mode: Mode;
  thresholds: Thresholds;
  parcels: Record<string, ParcelState>;
  order: string[];
  currentId?: string;
  calls: Record<string, CallState>;
  callOrder: string[];
  tools: Record<string, ToolState>;
  toolOrder: string[];
  claims: Record<string, ClaimCard>;
  claimOrder: string[];
  humanQueue: string[];
  proposals: Record<string, ProposalState>;
  proposalOrder: string[];
  policyVersion: number;
  policy?: Policy;
  policyChangedTs?: number;
  adk: Record<string, NodeState>;
  stats?: Stats;
  skipped: { count: number; ms: number; cost: number };
  lastLive?: boolean;
  runStartTs?: number;
  runEnd?: { scorecard: Record<string, unknown>; report: unknown; ts: number };
  credit?: string;
  activeLlm?: string;
  notice?: { text: string; ts: number };
  h2h: H2HState;
  drift: { state: DriftState; level: number; offset: number; reason?: string };
  /** bumps on audit / drift / stats events, so the Safety view refetches GET /api/safety */
  safetyTick: number;
  caption?: Caption;
  /** another tab started a run of another mode: ignore that run's events (A15) */
  foreignRun: boolean;
  /** re-judge v1 vs v2, per proposal id (A10) */
  rejudge: Record<string, RejudgeResult>;
}

export const initialState: State = {
  streamStatus: "connecting",
  running: false,
  mode: "workflow",
  thresholds: { auto: 0.9, abstain: 0.4, ship: 0.9, retape: 0.85, hold: 0.5 },
  parcels: {},
  order: [],
  calls: {},
  callOrder: [],
  tools: {},
  toolOrder: [],
  claims: {},
  claimOrder: [],
  humanQueue: [],
  proposals: {},
  proposalOrder: [],
  policyVersion: 1,
  adk: {},
  skipped: { count: 0, ms: 0, cost: 0 },
  h2h: { rows: {}, order: [] },
  drift: { state: "normal", level: 0, offset: 0 },
  safetyTick: 0,
  foreignRun: false,
  rejudge: {},
};

export type Action =
  | { type: "event"; e: BeltEvent }
  | { type: "status"; s: State["streamStatus"] }
  | { type: "mode"; mode: Mode }
  | { type: "thresholds"; t: Thresholds }
  | { type: "running"; running: boolean }
  | { type: "credit"; credit: string }
  | { type: "policy"; policy: Policy }
  | { type: "proposal_status"; id: string; status: ProposalState["status"] }
  | { type: "dismiss_end" }
  | { type: "reset_run" }
  | { type: "hydrate"; pending: HumanItem[]; decided: HumanItem[]; proposals: ProposalPublic[] }
  | { type: "rejudge"; result: RejudgeResult };

function declaredText(d: Declared | string | undefined): { text: string; fragile: boolean } {
  if (!d) return { text: "", fragile: false };
  if (typeof d === "string") return { text: d, fragile: /fragile|glass/i.test(d) };
  const text = String(d.text ?? d.contents ?? d.declared ?? "");
  return { text, fragile: Boolean(d.fragile) };
}

function patchParcel(s: State, id: string, p: Partial<ParcelState>): State {
  const cur = s.parcels[id];
  if (!cur) return s;
  return { ...s, parcels: { ...s.parcels, [id]: { ...cur, ...p } } };
}

const KEEP_PARCELS = 400;

export function reduce(s: State, a: Action): State {
  switch (a.type) {
    case "status":
      return { ...s, streamStatus: a.s };
    case "mode":
      return { ...s, mode: a.mode };
    case "thresholds":
      return { ...s, thresholds: a.t };
    case "running":
      return { ...s, running: a.running };
    case "credit":
      return { ...s, credit: a.credit };
    case "policy":
      return { ...s, policy: a.policy, policyVersion: a.policy.version ?? s.policyVersion };
    case "proposal_status": {
      const p = s.proposals[a.id];
      if (!p) return s;
      return { ...s, proposals: { ...s.proposals, [a.id]: { ...p, status: a.status } } };
    }
    case "dismiss_end":
      return { ...s, runEnd: undefined };
    case "reset_run":
      // this tab's own START: a clean run view, and stop ignoring (A15)
      return {
        ...initialState,
        streamStatus: s.streamStatus,
        mode: s.mode,
        running: true,
        thresholds: s.thresholds,
        policy: s.policy,
        policyVersion: s.policyVersion,
        credit: s.credit,
      };
    case "hydrate":
      return hydrate(s, a.pending, a.decided, a.proposals);
    case "rejudge":
      return { ...s, rejudge: { ...s.rejudge, [a.result.proposal_id]: a.result } };
    case "event": {
      const e = a.e;
      if (e.type === "run_start") {
        if (e.mode && e.mode !== s.mode) return { ...s, foreignRun: true };
        return onEvent({ ...s, foreignRun: false }, e);
      }
      if (s.foreignRun && RUN_EVENTS.has(e.type) && !isTeachEvent(e)) return s;
      return onEvent(s, e);
    }
  }
}

/** Events that belong to one run. A tab ignores them while another tab's run (another mode) is on. */
const RUN_EVENTS = new Set<string>([
  "parcel", "jev_call", "route", "gemini_skipped", "llm_start", "llm_delta", "llm_end", "tool_proposed",
  "guard_verdict", "decision", "adk_node", "stats", "audit", "drift", "h2h_answer", "h2h_result", "h2h_stats",
  "run_end", "run_stopped", "run_error", "step", "human_queue", "label_read", "claim_packet",
]);

function isTeachEvent(e: BeltEvent): boolean {
  if (e.type === "adk_node") return e.node.startsWith("teach");
  if (e.type === "llm_start" || e.type === "llm_end") return e.agent === "teacher";
  return false;
}

/** After a reload in mode 3 (A15): the desk (waiting and decided) and the latest teacher proposal. */
function hydrate(s: State, pending: HumanItem[], decided: HumanItem[], props: ProposalPublic[]): State {
  const parcels = { ...s.parcels };
  const order = [...s.order];
  const now = Date.now() / 1000;
  for (const it of [...decided, ...pending]) {
    if (parcels[it.parcel_id]) continue;
    const j = it.jev ?? {};
    parcels[it.parcel_id] = {
      id: it.parcel_id,
      photo_url: it.photo_url ?? `/api/photos/${it.parcel_id}.jpg`,
      declared: it.declared ?? "",
      fragile: /fragile|glass|ceramic/i.test(it.declared ?? ""),
      index: order.length + 1,
      total: 0,
      ts: now,
      jev: j.choice
        ? { call_id: "", ms: 0, cost: 0, live: false, probabilities: j.probabilities ?? {}, confidence: j.confidence ?? 0, action: j.choice, tokens_in: 0, model_choice: j.choice, damaged: it.damaged ?? j.damaged, risk: it.risk ?? undefined }
        : undefined,
      lane: "human",
      rule: it.rule ?? undefined,
      checks: it.checks ?? undefined,
      escalatedFrom: it.second_look && !String(it.second_look.reason ?? "").includes("Gemini skipped") ? "gemini" : undefined,
      humanKind: it.kind ?? "decide",
      secondLook: it.second_look ?? null,
      handling: it.handling,
      autoAction: it.auto_action ?? null,
      humanReason: it.reason,
      humanAction: it.status === "decided" ? (it.action ?? undefined) : undefined,
      truth: it.truth ?? null,
      policyVersion: s.policyVersion,
      geminiCallIds: [],
    };
    order.push(it.parcel_id);
  }
  const humanQueue = [...s.humanQueue, ...pending.map((i) => i.parcel_id).filter((id) => !s.humanQueue.includes(id))];
  const proposals: Record<string, ProposalState> = { ...s.proposals };
  const proposalOrder = [...s.proposalOrder];
  for (const p of props) {
    if (proposals[p.proposal_id]) continue;
    const status: ProposalState["status"] = p.status === "no_change" ? "no_change" : p.applied_version || p.status === "approved" ? "approved" : "pending";
    proposals[p.proposal_id] = { ...p, type: "teach_proposal", ts: now, status, approvedVersion: p.applied_version ?? undefined };
    proposalOrder.push(p.proposal_id);
  }
  return { ...s, parcels, order, humanQueue, proposals, proposalOrder };
}

function onEvent(s: State, e: BeltEvent): State {
  switch (e.type) {
    case "run_start":
      return {
        ...initialState,
        streamStatus: s.streamStatus,
        mode: e.mode ?? s.mode,
        running: true,
        thresholds: e.thresholds ?? s.thresholds,
        policyVersion: e.policy_version ?? s.policyVersion,
        policy: s.policy,
        credit: e.credit || s.credit,
        runStartTs: e.ts,
        safetyTick: s.safetyTick + 1,
        h2h: { rows: {}, order: [], prices: e.prices, geminiModel: e.gemini_model, jevModel: e.jev_model, gemmaModel: e.gemma_model },
      };
    case "parcel": {
      const d = declaredText(e.declared);
      const p: ParcelState = {
        id: e.parcel_id,
        photo_url: e.photo_url,
        declared: d.text,
        fragile: d.fragile,
        index: e.index,
        total: e.total,
        ts: e.ts,
        policyVersion: s.policyVersion,
        geminiCallIds: [],
      };
      let order = s.order.includes(e.parcel_id) ? s.order : [...s.order, e.parcel_id];
      let parcels = { ...s.parcels, [e.parcel_id]: { ...s.parcels[e.parcel_id], ...p } };
      if (order.length > KEEP_PARCELS) {
        const drop = order.slice(0, order.length - KEEP_PARCELS);
        order = order.slice(-KEEP_PARCELS);
        parcels = { ...parcels };
        for (const id of drop) delete parcels[id];
      }
      const h2h =
        s.mode === "h2h" && !s.h2h.rows[e.parcel_id]
          ? { ...s.h2h, rows: { ...s.h2h.rows, [e.parcel_id]: { id: e.parcel_id, done: false } }, order: [...s.h2h.order, e.parcel_id] }
          : s.h2h;
      return { ...s, running: true, order, parcels, currentId: e.parcel_id, credit: s.credit || e.credit, h2h };
    }
    case "jev_call": {
      const call: CallState = {
        call_id: e.call_id,
        kind: "jev",
        parcel_id: e.parcel_id,
        start: e.ts - e.ms / 1000,
        end: e.ts,
        ms: e.ms,
        live: e.live,
        text: "",
        output: { probabilities: e.probabilities, action: e.action, confidence: e.confidence },
        cost: e.cost,
        tokens_in: e.tokens_in,
        tokens_out: e.tokens_out,
      };
      const next = {
        ...s,
        lastLive: e.live,
        calls: { ...s.calls, [e.call_id]: call },
        callOrder: [...s.callOrder.slice(-600), e.call_id],
      };
      return patchParcel(next, e.parcel_id, {
        jev: {
          call_id: e.call_id,
          ms: e.ms,
          cost: e.cost,
          live: e.live,
          probabilities: e.probabilities,
          confidence: e.confidence,
          action: e.action,
          tokens_in: e.tokens_in,
          policy_version: e.policy_version,
          model_choice: e.model_choice,
          damaged: e.damaged,
          risk: e.risk,
          why: e.why,
        },
        policyVersion: e.policy_version ?? s.policyVersion,
      });
    }
    case "route":
      return patchParcel({ ...s, thresholds: e.thresholds ?? s.thresholds }, e.parcel_id, {
        lane: e.lane,
        laneTs: e.ts,
        reason: e.reason,
        ...(e.escalated_from
          ? { escalatedFrom: e.escalated_from }
          : { rule: e.rule, tier: e.tier, bar: e.bar, checks: e.checks, legacyLane: e.legacy_lane }),
      });
    case "gemini_skipped":
      return patchParcel(
        {
          ...s,
          skipped: {
            count: s.skipped.count + 1,
            ms: s.skipped.ms + (e.saved_ms_est || 0),
            cost: s.skipped.cost + (e.saved_cost_est || 0),
          },
        },
        e.parcel_id,
        { geminiSkipped: true },
      );
    case "llm_start": {
      const call: CallState = {
        call_id: e.call_id,
        kind: "llm",
        agent: e.agent,
        job: e.job ?? AGENT_JOB[e.agent],
        jobLabel: e.job_label,
        parcel_id: e.parcel_id,
        start: e.ts,
        text: "",
      };
      let next: State = {
        ...s,
        calls: { ...s.calls, [e.call_id]: call },
        callOrder: [...s.callOrder.slice(-600), e.call_id],
        activeLlm: e.call_id,
      };
      if (e.parcel_id && s.parcels[e.parcel_id]) {
        next = patchParcel(next, e.parcel_id, {
          geminiCallIds: [...s.parcels[e.parcel_id].geminiCallIds, e.call_id],
        });
      }
      return next;
    }
    case "llm_delta": {
      const c = s.calls[e.call_id];
      if (!c) return s;
      const next = e.thought ? { ...c, thought: (c.thought ?? "") + e.text } : { ...c, text: c.text + e.text };
      return { ...s, calls: { ...s.calls, [e.call_id]: next } };
    }
    case "llm_end": {
      const c = s.calls[e.call_id] ?? { call_id: e.call_id, kind: "llm" as const, start: e.ts - e.ms / 1000, text: "" };
      return {
        ...s,
        lastLive: e.live,
        calls: {
          ...s.calls,
          [e.call_id]: {
            ...c,
            agent: e.agent,
            job: c.job ?? e.job ?? AGENT_JOB[e.agent],
            end: e.ts,
            ms: e.ms,
            live: e.live,
            output: e.output,
            cost: e.cost,
            tokens_in: e.tokens_in,
            tokens_out: e.tokens_out,
            text: c.text || (typeof e.output === "string" ? e.output : JSON.stringify(e.output, null, 1)),
          },
        },
        callOrder: s.callOrder.includes(e.call_id) ? s.callOrder : [...s.callOrder, e.call_id],
      };
    }
    case "tool_proposed":
      return {
        ...s,
        tools: {
          ...s.tools,
          [e.call_id]: {
            call_id: e.call_id,
            proposed: e,
            parcel_id: (e.args?.parcel_id as string) ?? s.calls[e.call_id]?.parcel_id,
          },
        },
        toolOrder: [...s.toolOrder.filter((x) => x !== e.call_id), e.call_id],
      };
    case "guard_verdict": {
      const t = s.tools[e.call_id];
      if (!t) {
        return s;
      }
      const tool = { ...t, verdict: e };
      const pid = tool.parcel_id;
      const c = pid ? s.claims[pid] : undefined;
      return {
        ...s,
        tools: { ...s.tools, [e.call_id]: tool },
        claims: c && pid ? { ...s.claims, [pid]: { ...c, tool } } : s.claims,
      };
    }
    case "label_read":
      return {
        ...s,
        claims: {
          ...s.claims,
          [e.parcel_id]: { parcel_id: e.parcel_id, url: e.url, scan: e.scan, declared: e.declared, reading: true },
        },
        claimOrder: [...s.claimOrder.filter((x) => x !== e.parcel_id), e.parcel_id],
      };
    case "claim_packet": {
      const prev = s.claims[e.parcel_id];
      const tool = Object.values(s.tools).filter((t) => t.parcel_id === e.parcel_id).pop() ?? prev?.tool;
      return {
        ...s,
        claims: {
          ...s.claims,
          [e.parcel_id]: { parcel_id: e.parcel_id, url: e.url, scan: e.scan, declared: e.declared ?? prev?.declared,
            reading: false, packet: e, tool },
        },
        claimOrder: s.claimOrder.includes(e.parcel_id) ? s.claimOrder : [...s.claimOrder, e.parcel_id],
      };
    }
    case "decision":
      // several decisions per parcel are normal (code hold, then the human; a claim after Gemini): last wins
      return patchParcel(s, e.parcel_id, {
        final: e.final_action,
        decidedBy: e.decided_by,
        decidedTs: e.ts,
        firstDecidedTs: s.parcels[e.parcel_id]?.firstDecidedTs ?? (e.decided_by === "code" && e.final_action === "hold" ? undefined : e.ts),
      });
    case "human_queue": {
      const cur = s.parcels[e.parcel_id];
      const audit = e.kind === "audit";
      const next = patchParcel(s, e.parcel_id, {
        humanReason: e.reason,
        lane: cur?.lane ?? "human",
        humanKind: e.kind ?? "decide",
        secondLook: e.second_look ?? cur?.secondLook,
        handling: e.handling ?? cur?.handling,
        autoAction: audit ? (e.auto_action ?? cur?.final) : cur?.autoAction,
        rule: cur?.rule ?? e.rule ?? undefined,
        tier: cur?.tier ?? e.tier ?? undefined,
        checks: cur?.checks ?? e.checks ?? undefined,
        humanAction: audit ? undefined : cur?.humanAction,
        truth: e.truth ?? cur?.truth,
      });
      return { ...next, humanQueue: next.humanQueue.includes(e.parcel_id) ? next.humanQueue : [...next.humanQueue, e.parcel_id] };
    }
    case "human_decided": {
      const next = patchParcel(s, e.parcel_id, { humanAction: e.action });
      return { ...next, humanQueue: next.humanQueue.filter((x) => x !== e.parcel_id) };
    }
    case "teach_proposal":
      return {
        ...s,
        proposals: { ...s.proposals, [e.proposal_id]: { ...e, status: e.status === "no_change" ? "no_change" : "pending" } },
        proposalOrder: [...s.proposalOrder.filter((x) => x !== e.proposal_id), e.proposal_id],
      };
    case "policy_version": {
      const proposals = { ...s.proposals };
      if (e.version > s.policyVersion) {
        for (const id of Object.keys(proposals)) {
          if (proposals[id].status === "approving") proposals[id] = { ...proposals[id], status: "approved", approvedVersion: e.version };
        }
      }
      return {
        ...s,
        proposals,
        policy: e.policy ?? s.policy,
        policyChangedTs: e.version !== s.policyVersion ? e.ts : s.policyChangedTs,
        policyVersion: e.version,
      };
    }
    case "adk_node": {
      const cur = s.adk[e.node];
      return {
        ...s,
        adk: {
          ...s.adk,
          [e.node]: { phase: e.phase, ts: e.ts, count: (cur?.count ?? 0) + (e.phase === "start" ? 1 : 0) },
        },
      };
    }
    case "stats": {
      const { type: _t, ts: _ts, ...rest } = e;
      void _t;
      void _ts;
      const d = rest.safety?.drift;
      return {
        ...s,
        stats: rest,
        drift: d ? { ...s.drift, state: d.state, level: d.level, offset: d.offset } : s.drift,
        safetyTick: rest.safety ? s.safetyTick + 1 : s.safetyTick,
      };
    }
    case "audit": {
      const cur = s.parcels[e.parcel_id];
      const audit =
        e.phase === "start"
          ? { status: "running" as const }
          : {
              ...(cur?.audit ?? {}),
              status: "done" as const,
              gemini_action: e.gemini_action ?? cur?.audit?.gemini_action,
              gemini_reason: e.gemini_reason ?? cur?.audit?.gemini_reason,
              flagged: e.flagged ?? cur?.audit?.flagged,
              error: e.error,
              label: e.label,
              label_source: e.label_source,
            };
      return patchParcel({ ...s, safetyTick: s.safetyTick + 1 }, e.parcel_id, { audit });
    }
    case "drift":
      return { ...s, drift: { state: e.state, level: e.level, offset: e.offset, reason: e.reason }, safetyTick: s.safetyTick + 1 };
    case "h2h_answer": {
      const { type: _t, ts: _ts, side, parcel_id, ...rest } = e;
      void _t;
      void _ts;
      const cur = s.h2h.rows[parcel_id] ?? { id: parcel_id, done: false };
      const row = { ...cur, [side]: rest as H2HSide };
      const order = s.h2h.order.includes(parcel_id) ? s.h2h.order : [...s.h2h.order, parcel_id];
      const lastLive = rest.live;
      let calls = s.calls;
      let callOrder = s.callOrder;
      if (side === "jev" && rest.call_id && rest.ms != null) {
        const call: CallState = {
          call_id: rest.call_id,
          kind: "jev",
          parcel_id,
          start: e.ts - rest.ms / 1000,
          end: e.ts,
          ms: rest.ms,
          live: rest.live,
          text: "",
          output: { probabilities: rest.probabilities, action: rest.action },
          cost: rest.cost,
          tokens_in: rest.tokens_in,
          tokens_out: rest.tokens_out,
        };
        calls = { ...calls, [rest.call_id]: call };
        callOrder = [...callOrder.slice(-600), rest.call_id];
      }
      return { ...s, lastLive, calls, callOrder, h2h: { ...s.h2h, rows: { ...s.h2h.rows, [parcel_id]: row }, order } };
    }
    case "h2h_result": {
      const row: H2HRow = { id: e.parcel_id, jev: e.jev, gemini: e.gemini, gemma: e.gemma, truth: e.truth, agree: e.agree, done: true };
      const order = s.h2h.order.includes(e.parcel_id) ? s.h2h.order : [...s.h2h.order, e.parcel_id];
      return { ...s, h2h: { ...s.h2h, rows: { ...s.h2h.rows, [e.parcel_id]: row }, order } };
    }
    case "h2h_stats": {
      const { type: _t, ts: _ts, ...board } = e;
      void _t;
      void _ts;
      return { ...s, h2h: { ...s.h2h, board } };
    }
    case "run_end":
      if (s.mode === "h2h" || (e.scorecard && "agreement_rate" in e.scorecard)) {
        return { ...s, running: false, h2h: { ...s.h2h, board: (e.scorecard as unknown as H2HBoard) ?? s.h2h.board }, runEnd: { scorecard: e.scorecard ?? {}, report: e.report, ts: e.ts } };
      }
      return { ...s, running: false, runEnd: { scorecard: e.scorecard ?? {}, report: e.report, ts: e.ts } };
    case "thresholds":
      return { ...s, thresholds: { auto: e.auto, abstain: e.abstain, ship: e.ship ?? e.auto, retape: e.retape ?? s.thresholds.retape, hold: e.hold ?? s.thresholds.hold } };
    case "run_stopped":
      return { ...s, running: false };
    case "run_error":
      return { ...s, running: false, notice: { text: `run error: ${e.error}`, ts: e.ts } };
    case "teach_error":
      return { ...s, notice: { text: `teacher: ${e.error}`, ts: e.ts } };
    case "step":
      return { ...s, caption: { parcel_id: e.parcel_id, k: e.k, n: e.n, node: e.node, text: e.text, walk: !!e.walk, pause_s: e.pause_s ?? 0, ts: Date.now() / 1000 } };
    case "teach_rejudge": {
      const { type: _t, ts: _ts, ...result } = e;
      void _t;
      void _ts;
      return { ...s, rejudge: { ...s.rejudge, [result.proposal_id]: result } };
    }
    case "teach_approved": {
      const p = s.proposals[e.proposal_id];
      if (!p) return s;
      return { ...s, proposals: { ...s.proposals, [e.proposal_id]: { ...p, status: "approved", approvedVersion: e.version } } };
    }
    default:
      return s;
  }
}

// ── derived numbers ──────────────────────────────────────────────────────

export interface LaneSummary {
  count: number;
  avgMs: number | null;
  ids: string[];
}

/** Per-lane counts and average time from parcel arrival to final decision (from event timestamps). */
export function laneSummaries(s: State): Record<Lane, LaneSummary> {
  const out: Record<Lane, LaneSummary> = {
    auto: { count: 0, avgMs: null, ids: [] },
    gemini: { count: 0, avgMs: null, ids: [] },
    human: { count: 0, avgMs: null, ids: [] },
  };
  const sums: Record<Lane, [number, number]> = { auto: [0, 0], gemini: [0, 0], human: [0, 0] };
  for (const id of s.order) {
    const p = s.parcels[id];
    if (!p?.lane) continue;
    out[p.lane].count += 1;
    out[p.lane].ids.push(id);
    // time to the lane's own decision: Jev's or Gemini's first answer, or the person's
    const at = p.lane === "human" ? (p.humanAction ? p.decidedTs : undefined) : (p.firstDecidedTs ?? p.decidedTs);
    if (at !== undefined) {
      sums[p.lane][0] += (at - p.ts) * 1000;
      sums[p.lane][1] += 1;
    }
  }
  for (const l of ["auto", "gemini", "human"] as Lane[]) {
    if (sums[l][1]) out[l].avgMs = sums[l][0] / sums[l][1];
  }
  // the server's own counts win when present
  if (s.stats) {
    out.auto.count = Math.max(out.auto.count, s.stats.lanes.auto);
    out.gemini.count = Math.max(out.gemini.count, s.stats.lanes.gemini);
    out.human.count = Math.max(out.human.count, s.stats.lanes.human);
  }
  return out;
}

/** Mode 3 numbers, like with like: Jev decisions vs Gemini decision calls (2nd look); other Gemini work apart. */
export function jobTotals(s: State) {
  const by: Record<Job, { calls: number; ms: number; msN: number; cost: number }> = {
    decision: { calls: 0, ms: 0, msN: 0, cost: 0 },
    clerk: { calls: 0, ms: 0, msN: 0, cost: 0 },
    report: { calls: 0, ms: 0, msN: 0, cost: 0 },
    teacher: { calls: 0, ms: 0, msN: 0, cost: 0 },
  };
  for (const id of s.callOrder) {
    const c = s.calls[id];
    if (!c || c.kind !== "llm" || c.ms === undefined) continue;
    const j = by[jobOf(c)];
    j.calls++;
    j.cost += c.cost ?? 0;
    if (c.live !== false) {
      j.ms += c.ms;
      j.msN++;
    }
  }
  const st = s.stats;
  const dec = by.decision;
  const work = { calls: by.clerk.calls + by.report.calls + by.teacher.calls, cost: by.clerk.cost + by.report.cost + by.teacher.cost };
  return {
    decision: {
      calls: Math.max(dec.calls, st?.gemini_decision_calls ?? 0),
      avgMs: st?.gemini_decision_ms_avg ?? (dec.msN ? dec.ms / dec.msN : null),
      cost: st?.gemini_decision_cost ?? dec.cost,
    },
    work: {
      calls: Math.max(work.calls, st?.gemini_work_calls ?? 0),
      cost: st?.gemini_work_cost ?? work.cost,
      byJob: { clerk: by.clerk.calls, report: by.report.calls, teacher: by.teacher.calls },
    },
  };
}

export function modelTotals(s: State) {
  let jevN = 0,
    jevMs = 0,
    jevCost = 0,
    gemN = 0,
    gemMs = 0,
    gemCost = 0;
  for (const id of s.callOrder) {
    const c = s.calls[id];
    if (!c || c.ms === undefined) continue;
    if (c.kind === "jev") {
      jevN++;
      jevMs += c.ms;
      jevCost += c.cost ?? 0;
    } else {
      gemN++;
      gemMs += c.ms;
      gemCost += c.cost ?? 0;
    }
  }
  const st = s.stats;
  return {
    jev: {
      calls: Math.max(jevN, st?.parcels ?? 0),
      avgMs: st?.jev_ms_avg || (jevN ? jevMs / jevN : null),
      cost: st?.jev_cost ?? jevCost,
    },
    gemini: {
      calls: Math.max(gemN, st?.gemini_calls ?? 0),
      avgMs: gemN ? gemMs / gemN : null,
      cost: st?.gemini_cost ?? gemCost,
    },
  };
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(3)}`;
}

/** Per-action bar from thresholds (auto is the ship bar on the wire). */
export function barFor(t: Thresholds, action: string | undefined): number | null {
  if (action === "ship") return t.ship ?? t.auto;
  if (action === "retape") return t.retape ?? t.auto;
  if (action === "hold") return t.hold ?? t.auto;
  return null; // return / refund never auto
}

export const RULE_LABEL: Record<string, string> = {
  abstain_low_confidence: "Jev unsure",
  return_never_auto: "return never auto",
  cross_check_disagree: "answers disagree",
  marks_vs_declared: "marks vs declared",
  fragile_no_auto_ship: "fragile: no auto-ship",
  drift_paused: "drift: auto paused",
  below_ship_bar: "below ship bar",
  below_retape_bar: "below retape bar",
  below_hold_bar: "below hold bar",
  auto_ship: "auto ship",
  auto_retape: "auto retape",
  auto_hold: "auto hold",
};
