// Typed client for the belt server. Two implementations behind one interface:
//   - HttpApi: the real FastAPI server (SSE GET /api/stream + REST under /api)
//   - MockApi (mock.ts): an in-browser event replayer, so the page works with no backend
import type {
  BeltEvent,
  ContextResult,
  InspectRecord,
  HumanItem,
  JudgeResult,
  Mode,
  ProposalPublic,
  RejudgeResult,
  SafetyState,
  YouJevResult,
  Policy,
  Thresholds,
} from "./types";

export type StreamStatus = "connecting" | "open" | "error";

export interface RunRequest {
  mode: Mode;
  pace?: number;
  limit?: number | null;
  /** a named parcel set on the server (belt/sets.py), e.g. "r3" */
  set?: string | null;
  /** an explicit, ordered parcel list; wins over set and limit */
  ids?: string[] | null;
  /** mode 3: parcel 1 walks the graph slowly */
  walk?: boolean;
}

export interface BeltApi {
  readonly kind: "server" | "mock";
  subscribe(onEvent: (e: BeltEvent) => void, onStatus: (s: StreamStatus) => void): () => void;
  run(req: RunRequest): Promise<unknown>;
  stop(): Promise<unknown>;
  getThresholds(): Promise<Thresholds>;
  setThresholds(t: Thresholds): Promise<Thresholds>;
  getPolicy(): Promise<Policy>;
  setPolicy(body: { options?: Record<string, string>; preset?: string; name?: string }): Promise<Policy>;
  decideHuman(parcelId: string, action: string): Promise<unknown>;
  teachRun(): Promise<unknown>;
  teachApprove(proposalId: string): Promise<unknown>;
  /** v1 vs v2: Jev on the proposal's cited parcels under the old and the new policy */
  teachRejudge(proposalId: string): Promise<RejudgeResult>;
  /** rehydrate after a reload (A15): the desk and the teacher's proposals */
  getHuman(): Promise<{ pending: HumanItem[]; decided: HumanItem[] }>;
  getTeach(): Promise<{ proposals: ProposalPublic[]; rejudge?: Record<string, RejudgeResult> }>;
  contextTest(body: { photo?: string; a: string; b: string }): Promise<ContextResult>;
  inspect(callId: string): Promise<InspectRecord>;
  photoCredit(): Promise<string>;
  /** "You sort" on the server: the parcel list and the answer-key grader (client-paced). */
  manifest(): Promise<{ parcels: { id: string; url: string; declared: string }[] }>;
  /** action may be "missed" (the countdown ran out; the belt does not wait). */
  judge(id: string, action: string): Promise<JudgeResult>;
  /** The safety gate: bars, audit, drift, routes of the last run, calibration. */
  getSafety(): Promise<SafetyState>;
  setSafety(body: Record<string, unknown>): Promise<SafetyState>;
  /** Mode 1 summary: Jev on the same parcels (live by default; per-row `live` says which). */
  youJev(ids: string[], source?: "live" | "replay"): Promise<YouJevResult>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function http<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && typeof j.detail === "string") msg = j.detail;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Normalise server timestamps to seconds (accepts seconds or milliseconds). */
export function toSeconds(ts: number | undefined): number {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return Date.now() / 1000;
  return ts > 1e12 ? ts / 1000 : ts;
}

export class HttpApi implements BeltApi {
  readonly kind = "server" as const;

  subscribe(onEvent: (e: BeltEvent) => void, onStatus: (s: StreamStatus) => void): () => void {
    onStatus("connecting");
    const es = new EventSource("/api/stream");
    es.onopen = () => onStatus("open");
    es.onerror = () => onStatus(es.readyState === EventSource.CLOSED ? "error" : "connecting");
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as BeltEvent;
        if (e && typeof e.type === "string") onEvent({ ...e, ts: toSeconds(e.ts) });
      } catch {
        /* ignore keep-alives and malformed frames */
      }
    };
    return () => es.close();
  }
  run(req: RunRequest) {
    return http("POST", "/api/run", req);
  }
  stop() {
    return http("POST", "/api/stop", {});
  }
  getThresholds() {
    return http<Thresholds>("GET", "/api/thresholds");
  }
  setThresholds(t: Thresholds) {
    return http<Thresholds>("POST", "/api/thresholds", t);
  }
  getPolicy() {
    return http<Policy>("GET", "/api/policy");
  }
  setPolicy(body: { options?: Record<string, string>; preset?: string; name?: string }) {
    return http<Policy>("POST", "/api/policy", body);
  }
  decideHuman(parcelId: string, action: string) {
    return http("POST", `/api/human/${encodeURIComponent(parcelId)}`, { action });
  }
  teachRun() {
    return http("POST", "/api/teach/run", {});
  }
  teachApprove(proposalId: string) {
    return http("POST", `/api/teach/${encodeURIComponent(proposalId)}/approve`, {});
  }
  teachRejudge(proposalId: string) {
    return http<RejudgeResult>("POST", `/api/teach/${encodeURIComponent(proposalId)}/rejudge`, {});
  }
  getHuman() {
    return http<{ pending: HumanItem[]; decided: HumanItem[] }>("GET", "/api/human");
  }
  getTeach() {
    return http<{ proposals: ProposalPublic[]; rejudge?: Record<string, RejudgeResult> }>("GET", "/api/teach");
  }
  contextTest(body: { photo?: string; a: string; b: string }) {
    return http<ContextResult>("POST", "/api/context-test", body);
  }
  inspect(callId: string) {
    return http<InspectRecord>("GET", `/api/inspect/${encodeURIComponent(callId)}`);
  }
  manifest() {
    return http<{ parcels: { id: string; url: string; declared: string }[] }>("GET", "/api/manifest");
  }
  judge(id: string, action: string) {
    return http<JudgeResult>("POST", "/api/judge", { id, action });
  }
  getSafety() {
    return http<SafetyState>("GET", "/api/safety");
  }
  setSafety(body: Record<string, unknown>) {
    return http<SafetyState>("POST", "/api/safety", body);
  }
  youJev(ids: string[], source?: "live" | "replay") {
    return http<YouJevResult>("POST", "/api/you/jev", source ? { ids, source } : { ids });
  }
  async photoCredit(): Promise<string> {
    try {
      const r = await http<{ credit?: string; text?: string }>("GET", "/api/photo-source");
      return r.credit || r.text || "";
    } catch {
      return "";
    }
  }
}

/**
 * Pick the backend. `?mock=1` forces the replayer, `?mock=0` forces the server.
 * Otherwise, in `vite dev` only, fall back to the replayer when the server does not answer.
 */
export async function chooseApi(): Promise<BeltApi> {
  const q = new URLSearchParams(location.search).get("mock");
  const mock = async () => new (await import("./mock")).MockApi();
  if (q === "1") return mock();
  if (q === "0" || !import.meta.env.DEV) return new HttpApi();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 900);
    const res = await fetch("/api/thresholds", { signal: ctl.signal });
    clearTimeout(t);
    if (res.ok) return new HttpApi();
  } catch {
    /* no server */
  }
  return mock();
}
