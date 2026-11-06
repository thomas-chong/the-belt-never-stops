import * as React from "react";
import { Play, Square, Search, FlaskConical, ScrollText, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BeltApi } from "@/api";
import { initialState, reduce } from "@/state";
import type { Job, Mode, Thresholds } from "@/types";
import { RoleDot } from "@/components/bits";
import { ThresholdStrip } from "@/panels/ThresholdStrip";
import { Belt } from "@/panels/Belt";
import { ClaimForm, GeminiStream } from "@/panels/Gemini";
import { AdkGraph } from "@/panels/AdkGraph";
import { DESK_ACTIONS, Teacher } from "@/panels/HumanTeacher";
import { Timeline } from "@/panels/Timeline";
import { ContextTest, Inspector, PolicyEditor, Scorecard } from "@/panels/Overlays";
import { H2HView } from "@/panels/H2H";
import { YouSort } from "@/panels/YouSort";
import { DriftBadge, SafetyView } from "@/panels/Safety";
import { JudgedBanner, plainFirstLine, ReviewDialog, type ReviewItem } from "@/components/ReviewDialog";
import type { ParcelState } from "@/state";

const MODES: { mode: Mode; key: string; label: string }[] = [
  { mode: "you", key: "1", label: "Round 1 · You sort" },
  { mode: "h2h", key: "2", label: "Round 2 · Jev vs Gemini" },
  { mode: "workflow", key: "3", label: "Round 3 · The team" },
];

/** Pace presets (A3): seconds between parcels. A non-preset ?pace= value shows as one extra option. */
const PACE_PRESETS: { value: number; label: string }[] = [
  { value: 1.5, label: "Narrate 1.5 s" },
  { value: 1, label: "Normal 1.0 s" },
  { value: 0.4, label: "Fast 0.4 s" },
];
const COUNTS = [8, 12, 30];
type PanelId = "inspector" | "context" | "policy" | "safety";
const PANELS: PanelId[] = ["context", "safety", "policy", "inspector"];

/** Stage URL parameters (fix-spec A2), read once on load. Unknown values fall back to the default. */
export interface Stage {
  pace: number;
  /** the ?pace= value when it is not a preset (e.g. 0 for tests) */
  extraPace: number | null;
  limit: number | null;
  set: string | null;
  ids: string[] | null;
  walk: boolean;
  presenter: boolean;
  clean: boolean;
  calib: boolean;
  panel: PanelId | null;
}

export function readStage(q: URLSearchParams): Stage {
  const num = (k: string) => (q.get(k) === null || q.get(k) === "" ? NaN : Number(q.get(k)));
  const p = num("pace");
  const pace = Number.isFinite(p) && p >= 0 && p <= 5 ? p : 1;
  const l = num("limit");
  const ids = (q.get("ids") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 30);
  const set = q.get("set")?.trim() || null;
  const panel = q.get("panel") as PanelId | null;
  return {
    pace,
    extraPace: PACE_PRESETS.some((x) => x.value === pace) ? null : pace,
    limit: Number.isInteger(l) && l >= 1 && l <= 30 ? l : null,
    set: ids.length ? null : set,
    ids: ids.length ? ids : null,
    walk: q.get("walk") === "1",
    presenter: q.get("presenter") === "1",
    clean: q.get("clean") === "1",
    calib: q.get("calib") === "1",
    panel: panel && PANELS.includes(panel) ? panel : null,
  };
}

function reviewItem(p: ParcelState): ReviewItem {
  return {
    id: p.id,
    photo_url: p.photo_url,
    declared: p.declared,
    handling: p.handling,
    jev: p.jev && { probabilities: p.jev.probabilities, confidence: p.jev.confidence, damaged: p.jev.damaged, risk: p.jev.risk, model_choice: p.jev.model_choice, action: p.jev.action },
    secondLook: p.secondLook,
    rule: p.rule,
    reason: p.escalatedFrom ? `gate: ${p.reason ?? ""} → the 2nd look sent it on: ${p.humanReason ?? ""}` : (p.humanReason ?? p.reason),
    checks: p.checks,
    kind: p.humanKind,
    autoAction: p.autoAction,
    escalated: p.escalatedFrom === "gemini",
    truth: p.truth,
  };
}

/** Mode 3 colour key: every Gemini call is labelled by its job (same colours as the timeline bars). */
export const JOB_KEY: { job: Job; label: string }[] = [
  { job: "decision", label: "2nd look (decision)" },
  { job: "clerk", label: "clerk (label → claim)" },
  { job: "report", label: "report" },
  { job: "teacher", label: "teacher" },
];

function useStageScale() {
  const [scale, setScale] = React.useState(1);
  React.useLayoutEffect(() => {
    const f = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    f();
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return scale;
}

export default function App({ api }: { api: BeltApi }) {
  const params = React.useMemo(() => new URLSearchParams(location.search), []);
  const [s, dispatch] = React.useReducer(reduce, initialState, (st) => ({
    ...st,
    mode: (MODES.find((m) => m.mode === params.get("mode"))?.mode ?? "workflow") as Mode,
  }));
  const stage = React.useMemo(() => readStage(params), [params]);
  const [pace, setPace] = React.useState(stage.pace);
  const [count, setCount] = React.useState<number>(stage.limit && COUNTS.includes(stage.limit) ? stage.limit : (stage.limit ?? 30));
  const [panel, setPanel] = React.useState<null | PanelId>(stage.panel);
  const [showKey, setShowKey] = React.useState(stage.presenter);
  const [reviewId, setReviewId] = React.useState<string | null>(null);
  const [inspectId, setInspectId] = React.useState<string | undefined>();
  const [selected, setSelected] = React.useState<string | undefined>();
  const [error, setError] = React.useState<string | null>(null);
  const scale = useStageScale();
  const fixedSet = stage.ids ? `ids · ${stage.ids.length} parcels` : stage.set ? `set ${stage.set}` : null;
  const [setCountN, setSetCountN] = React.useState<number | null>(stage.ids?.length ?? (stage.set === "r3" ? 12 : null));

  React.useEffect(() => {
    const unsub = api.subscribe(
      (e) => dispatch({ type: "event", e }),
      (st) => dispatch({ type: "status", s: st }),
    );
    api.getThresholds().then((t) => dispatch({ type: "thresholds", t })).catch(() => {});
    api.getPolicy().then((p) => dispatch({ type: "policy", policy: p })).catch(() => {});
    api.photoCredit().then((c) => c && dispatch({ type: "credit", credit: c }));
    if (s.mode === "workflow") {
      // A15: a reload between B3a and B3b keeps the desk and the teacher's proposal
      Promise.all([api.getHuman(), api.getTeach()])
        .then(([h, t]) => {
          dispatch({ type: "hydrate", pending: h.pending ?? [], decided: h.decided ?? [], proposals: t.proposals ?? [] });
          for (const result of Object.values(t.rejudge ?? {})) dispatch({ type: "rejudge", result });
        })
        .catch(() => {});
    }
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  React.useEffect(() => {
    if (s.notice) {
      setError(s.notice.text);
      const t = setTimeout(() => setError(null), 6000);
      return () => clearTimeout(t);
    }
  }, [s.notice]);

  const report = (e: unknown) => {
    setError((e as Error)?.message ?? String(e));
    setTimeout(() => setError(null), 5000);
  };

  const start = async () => {
    try {
      dispatch({ type: "reset_run" });
      const r = (await api.run({
        mode: s.mode,
        pace,
        limit: fixedSet ? null : count,
        set: stage.set,
        ids: stage.ids,
        walk: s.mode === "workflow" && stage.walk,
      })) as { parcels?: string[] | null } | undefined;
      if (r?.parcels) setSetCountN(r.parcels.length);
    } catch (e) {
      dispatch({ type: "running", running: false });
      report(e);
    }
  };
  const stop = async () => {
    try {
      await api.stop();
    } catch (e) {
      report(e);
    }
    dispatch({ type: "running", running: false });
  };
  const commitThresholds = (t: Thresholds) => {
    dispatch({ type: "thresholds", t });
    api.setThresholds(t).then((r) => dispatch({ type: "thresholds", t: r })).catch(report);
  };
  // every person decision in mode 3 is graded against the answer key right away (banner + running tally)
  const [judged, setJudged] = React.useState<{ id: string; action: string; truth: string | null; n: number }[]>([]);
  const decide = (pid: string, action: string) => {
    const truth = s.parcels[pid]?.truth ?? null;
    setJudged((js) => [...js.filter((x) => x.id !== pid), { id: pid, action, truth, n: (js[js.length - 1]?.n ?? 0) + 1 }]);
    return api.decideHuman(pid, action).catch(report);
  };
  const lastJudged = judged[judged.length - 1];
  const graded = judged.filter((x) => x.truth);
  const personTally = { right: graded.filter((x) => x.truth === x.action).length, total: graded.length };
  const [showJudged, setShowJudged] = React.useState(false);
  React.useEffect(() => {
    if (!lastJudged) return;
    setShowJudged(true);
    const t = window.setTimeout(() => setShowJudged(false), 4000);
    return () => window.clearTimeout(t);
  }, [lastJudged?.n]);
  // review pop-up: decide, then move to the next waiting parcel (or close when none is left)
  const reviewQueue = s.humanQueue.filter((id) => s.parcels[id]);
  const reviewIdx = reviewId ? reviewQueue.indexOf(reviewId) : -1;
  const reviewDecide = (pid: string, action: string) => {
    void decide(pid, action);
    const rest = reviewQueue.filter((id) => id !== pid);
    const at = Math.max(0, reviewQueue.indexOf(pid));
    setReviewId(rest.length ? rest[Math.min(at, rest.length - 1)] : null);
  };
  const reviewMove = (d: number) => {
    if (!reviewQueue.length) return;
    const i = reviewIdx < 0 ? 0 : (reviewIdx + d + reviewQueue.length) % reviewQueue.length;
    setReviewId(reviewQueue[i]);
  };
  const [teaching, setTeaching] = React.useState(false);
  const [teachStart, setTeachStart] = React.useState<number | undefined>();
  const teach = () => {
    setTeaching(true);
    setTeachStart(Date.now());
    api
      .teachRun()
      .catch(report)
      .finally(() => setTeaching(false));
  };
  const [rejudging, setRejudging] = React.useState(false);
  const rejudge = (id: string) => {
    setRejudging(true);
    api
      .teachRejudge(id)
      .then((result) => dispatch({ type: "rejudge", result }))
      .catch(report)
      .finally(() => setRejudging(false));
  };
  const approve = (id: string) => {
    dispatch({ type: "proposal_status", id, status: "approving" });
    api.teachApprove(id).catch((e) => {
      dispatch({ type: "proposal_status", id, status: "pending" });
      report(e);
    });
  };
  const inspect = (id: string) => {
    setInspectId(id);
    setPanel("inspector");
  };
  const selectParcel = (pid: string) => {
    setSelected(pid);
    const p = s.parcels[pid];
    const id = p?.geminiCallIds[p.geminiCallIds.length - 1] ?? p?.jev?.call_id;
    if (id) inspect(id);
  };
  const setMode = (m: Mode) => {
    if (s.running) return;
    dispatch({ type: "mode", mode: m });
    const u = new URL(location.href);
    u.searchParams.set("mode", m);
    history.replaceState(null, "", u);
  };

  // hotkeys
  const sRef = React.useRef(s);
  sRef.current = s;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = sRef.current;
      const k = e.key.toLowerCase();
      if (k === "escape") return; // Radix closes its own panels
      if (st.mode === "you") return; // mode 1 has its own keys (panels/YouSort.tsx)
      if (panel === null || panel === "inspector") {
        const m = MODES.find((x) => x.key === k);
        if (m) return setMode(m.mode);
        const a = DESK_ACTIONS.find((x) => x.key.toLowerCase() === k);
        if (a && st.humanQueue[0]) return void decide(st.humanQueue[0], a.action);
      }
      const target = k === "i" ? "inspector" : k === "c" ? "context" : k === "p" ? "policy" : k === "g" ? "safety" : null;
      if (target) {
        e.preventDefault(); // keep the letter out of the input that the dialog focuses
        setPanel((p) => (p === target ? null : target));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  // Inspector follows the newest call when nothing is pinned
  const latestCall = s.callOrder[s.callOrder.length - 1];
  React.useEffect(() => {
    if (panel === "inspector" && !inspectId && latestCall) setInspectId(latestCall);
  }, [panel, inspectId, latestCall]);

  const lastLive = s.lastLive;
  // A8: the scorecard waits for an empty desk; until then a toast says how many still wait
  const deskWaiting = s.mode === "workflow" && s.runEnd ? s.humanQueue.filter((id) => s.parcels[id]).length : 0;
  // A9: with clean=1, a proposal takes the whole middle column (the Gemini stream collapses to its header)
  const lastProposal = s.proposalOrder.length ? s.proposals[s.proposalOrder[s.proposalOrder.length - 1]] : undefined;
  const teacherWide = stage.clean && s.mode === "workflow" && (!!lastProposal || teaching);
  if (s.mode === "you") {
    return (
      <div className="relative h-full w-full overflow-hidden bg-background">
        <div className="absolute left-1/2 top-1/2 flex h-[1080px] w-[1920px] flex-col px-6 pb-2 pt-3" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
          <YouSort api={api} onMode={setMode} credit={s.credit} />
        </div>
      </div>
    );
  }
  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <div className="absolute left-1/2 top-1/2 flex h-[1080px] w-[1920px] flex-col gap-2.5 px-5 pb-1.5 pt-2.5" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        {/* header: title + legend, then the toolbar */}
        <header className="flex h-[46px] shrink-0 items-center gap-6">
          <h1 className="whitespace-nowrap text-[32px] font-bold leading-none tracking-tight">The belt never stops</h1>
          {s.mode === "h2h" ? (
            <p className="flex items-center gap-2 whitespace-nowrap text-[21px] text-muted-foreground">
              <RoleDot role="jev" /> <b className="text-jev-ink">Jev</b>{s.h2h.gemmaModel ? "," : " and"} <RoleDot role="gemini" /> <b className="text-gemini-ink">Gemini</b>{s.h2h.gemmaModel && <> and <RoleDot role="gemma" /> <b className="text-gemma-ink">Gemma 4</b></>} do the same job: decide each parcel
              <span className="mx-1.5 text-muted-foreground/50">·</span>
              <RoleDot role="adk" /> <b className="text-adk-ink">ADK</b> runs {s.h2h.gemmaModel ? "all three calls" : "both calls"}
            </p>
          ) : (
          <p className="flex items-center gap-2 whitespace-nowrap text-[21px] text-muted-foreground">
              <RoleDot role="jev" /> <b className="text-jev-ink">Jev</b> decides
              <span className="mx-1.5 text-muted-foreground/50">·</span>
              <RoleDot role="gemini" /> <b className="text-gemini-ink">Gemini</b> reads, double-checks, teaches
              <span className="mx-1.5 text-muted-foreground/50">·</span>
              <RoleDot role="adk" /> <b className="text-adk-ink">ADK</b> holds the gates
            </p>
          )}
          <div className="ml-auto flex items-center gap-3 text-[15px]">
            {api.kind === "mock" && <span className="rounded bg-foreground px-2 py-1 font-mono font-bold text-background">MOCK REPLAYER</span>}
            {!(stage.clean && s.mode === "workflow") && (
              <span className={cn("flex items-center gap-1.5 font-mono", s.streamStatus === "open" ? "text-success-foreground" : "text-error-foreground")}>
                <span className={cn("size-2.5 rounded-full", s.streamStatus === "open" ? "bg-success" : "bg-error")} />
                stream {s.streamStatus}
              </span>
            )}
          </div>
        </header>
        <div className="flex h-[52px] shrink-0 items-center gap-3">
          <nav className="flex rounded-lg border bg-card p-1 shadow-xs">
            {MODES.map((m) => (
              <button
                key={m.mode}
                onClick={() => setMode(m.mode)}
                disabled={s.running && s.mode !== m.mode}
                className={cn(
                  "flex h-10 items-center gap-2 whitespace-nowrap rounded-md px-3.5 text-[18px] font-medium transition-colors disabled:opacity-40",
                  s.mode === m.mode ? "bg-foreground text-background [&_kbd]:border-background/30 [&_kbd]:bg-foreground [&_kbd]:text-background/80" : "hover:bg-muted",
                )}
              >
                <kbd>{m.key}</kbd> {m.label}
              </button>
            ))}
          </nav>
          <div className="flex gap-2">
            {[
              { id: "inspector" as const, key: "I", label: "Inspector", icon: Search },
              { id: "context" as const, key: "C", label: "Context test", icon: FlaskConical },
              { id: "policy" as const, key: "P", label: "Policy", icon: ScrollText },
              ...(s.mode === "workflow" ? [{ id: "safety" as const, key: "G", label: "Safety", icon: ShieldCheck }] : []),
            ].map((t) => (
              <button key={t.id} onClick={() => setPanel(t.id)} title={t.label} aria-label={t.label} className="flex h-12 items-center gap-2 whitespace-nowrap rounded-lg border bg-card px-3 text-[18px] font-medium shadow-xs hover:bg-muted">
                <t.icon className="size-5 text-muted-foreground" />
                <kbd>{t.key}</kbd>
              </button>
            ))}
          </div>
          <DriftBadge state={s.drift.state} className="ml-auto" />
          <span className={cn("whitespace-nowrap rounded-lg border bg-card px-3 py-2 font-mono text-[18px] shadow-xs", s.drift.state === "normal" && "ml-auto")} title="policy version in force">
            policy <b>v{s.policyVersion}</b>
          </span>
          {lastLive !== undefined && (
            <span className="whitespace-nowrap font-mono text-[16px] text-muted-foreground">
              last call <b className={lastLive ? "text-success-foreground" : ""}>{lastLive ? "LIVE" : "REPLAY"}</b>
            </span>
          )}
          <select data-testid="pace" value={pace} disabled={s.running} onChange={(e) => setPace(Number(e.target.value))} className="h-12 rounded-lg border bg-card px-2 text-[18px] shadow-xs" title="seconds between parcels">
            {PACE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            {stage.extraPace !== null && <option value={stage.extraPace}>pace {stage.extraPace.toFixed(1)} s</option>}
          </select>
          {fixedSet ? (
            <span data-testid="parcel-count" className="flex h-12 items-center whitespace-nowrap rounded-lg border bg-muted px-3 font-mono text-[18px]" title="parcels fixed by the URL">
              {stage.ids ? fixedSet : `${fixedSet}${setCountN ? ` · ${setCountN} parcels` : ""}`}
            </span>
          ) : (
            <select data-testid="parcel-count" value={count} disabled={s.running} onChange={(e) => setCount(Number(e.target.value))} className="h-12 rounded-lg border bg-card px-2 text-[18px] shadow-xs" title="parcels in this run">
              {[...new Set([...COUNTS, count])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n} value={n}>
                    {n} parcels
                  </option>
                ))}
            </select>
          )}
          {s.running ? (
            <button onClick={stop} className="flex h-12 w-[150px] items-center justify-center gap-2 rounded-lg border-2 border-foreground bg-card text-[22px] font-bold">
              <Square className="size-5 fill-current" /> STOP
            </button>
          ) : (
            <button onClick={start} className="flex h-12 w-[150px] items-center justify-center gap-2 rounded-lg bg-foreground text-[22px] font-bold text-background shadow-sm hover:bg-foreground/90">
              <Play className="size-5 fill-current" /> START
            </button>
          )}
        </div>

        {s.mode === "h2h" ? (
          <main className="min-h-0 flex-1">
            <H2HView s={s} onInspect={inspect} calib={stage.calib} />
          </main>
        ) : (
          <>
        {s.mode === "workflow" && !stage.clean && (
          <div className="flex h-[34px] shrink-0 items-center gap-3 rounded-lg border border-gemini/30 bg-gemini-soft/60 px-4 text-[18px]">
            <b className="text-gemini-ink">Different jobs.</b>
            <span>Round 2 compared Jev and Gemini on the same job. Here they do different jobs.</span>
            <span className="ml-auto flex items-center gap-4 text-[15px] text-muted-foreground">
              {JOB_KEY.map((j) => (
                <span key={j.job} className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="inline-block h-3 w-5 rounded-sm" style={{ background: `var(--job-${j.job})` }} /> {j.label}
                </span>
              ))}
            </span>
          </div>
        )}
        <div className="h-[124px] shrink-0">
          <ThresholdStrip s={s} onCommit={commitThresholds} clean={stage.clean} title={stage.clean ? "2 Gates and lanes" : "Gates"} />
        </div>

        <main className={cn("grid min-h-0 flex-1 gap-3", teacherWide ? "grid-cols-[640px_minmax(0,1fr)_500px]" : "grid-cols-[730px_minmax(0,1fr)_640px]")}>
          <div className="min-h-0">
            <Belt s={s} onInspect={inspect} onSelect={selectParcel} onDecide={decide} onReview={setReviewId} selected={selected} title={stage.clean ? "1 The belt" : "The belt"} />
          </div>
          <div className="flex min-h-0 flex-col gap-3">
            <GeminiStream s={s} onInspect={inspect} collapsed={teacherWide} title={stage.clean ? "4 Gemini / Teacher" : "Gemini"} />
            <Teacher s={s} busy={teaching} startedAt={teachStart} onTeach={teach} onApprove={approve} onRejudge={rejudge} rejudging={rejudging} title={stage.clean ? (teacherWide ? "Teacher" : "4 Teacher") : "Teacher"} />
          </div>
          <div className="flex min-h-0 flex-col gap-3">
            <AdkGraph s={s} title={stage.clean ? "3 ADK workflow" : "ADK workflow"} />
            <ClaimForm s={s} onInspect={inspect} />
          </div>
        </main>

        <div className="h-[128px] shrink-0">
          <Timeline s={s} onInspect={inspect} />
        </div>
          </>
        )}

        <footer className={cn("flex h-[22px] shrink-0 items-center gap-4 text-[15px] text-muted-foreground", stage.clean && s.mode === "workflow" && "invisible")}>
          <span className="truncate">Photos: {s.credit || "credit line comes from the server"}</span>
          <span className="ml-auto whitespace-nowrap">
            <kbd>1</kbd>–<kbd>3</kbd> mode · <kbd>I</kbd> inspector · <kbd>C</kbd> context · <kbd>P</kbd> policy · <kbd>S</kbd>
            <kbd>R</kbd>
            <kbd>H</kbd>
            <kbd>X</kbd> desk · <kbd>G</kbd> safety · <kbd>Esc</kbd> close
          </span>
        </footer>

        {deskWaiting > 0 && (
          <div data-testid="desk-toast" className="absolute bottom-10 left-1/2 z-40 -translate-x-1/2 rounded-xl border-2 border-human bg-card px-6 py-3 text-[26px] font-semibold shadow-xl">
            Shift done · {deskWaiting} parcel{deskWaiting === 1 ? "" : "s"} still at the desk
          </div>
        )}
        {showJudged && lastJudged && !reviewId && (
          <div className="absolute left-1/2 top-24 z-40 -translate-x-1/2">
            <JudgedBanner j={lastJudged} tally={personTally} />
          </div>
        )}
        {error && <div className="absolute bottom-12 left-1/2 -translate-x-1/2 rounded-lg bg-error-foreground px-4 py-2 text-[18px] text-background shadow-lg">{error}</div>}
      </div>

      <Inspector api={api} s={s} open={panel === "inspector"} onOpenChange={(o) => setPanel(o ? "inspector" : null)} callId={inspectId} setCallId={setInspectId} />
      <ContextTest api={api} open={panel === "context"} onOpenChange={(o) => setPanel(o ? "context" : null)} onInspect={inspect} />
      <PolicyEditor api={api} open={panel === "policy"} onOpenChange={(o) => setPanel(o ? "policy" : null)} onApplied={(p) => dispatch({ type: "policy", policy: p })} />
      <Scorecard s={s} open={!!s.runEnd && deskWaiting === 0} calib={stage.calib} onClose={() => dispatch({ type: "dismiss_end" })} />
      <SafetyView api={api} s={s} open={panel === "safety"} onOpenChange={(o) => setPanel(o ? "safety" : null)} />
      <ReviewDialog
        open={!!reviewId && !!s.parcels[reviewId]}
        item={reviewId && s.parcels[reviewId] ? reviewItem(s.parcels[reviewId]) : undefined}
        onClose={() => setReviewId(null)}
        onDecide={reviewDecide}
        onPrev={reviewQueue.length > 1 ? () => reviewMove(-1) : undefined}
        onNext={reviewQueue.length > 1 ? () => reviewMove(1) : undefined}
        position={reviewIdx >= 0 ? { index: reviewIdx + 1, total: reviewQueue.length } : undefined}
        note={reviewIdx < 0 && reviewId ? "already decided" : "The belt keeps moving while you look."}
        firstLine={reviewId && s.parcels[reviewId] ? plainFirstLine(reviewItem(s.parcels[reviewId]), s.thresholds.abstain) : undefined}
        showKey={showKey}
        onToggleKey={() => setShowKey((k) => !k)}
        result={showJudged && lastJudged ? <JudgedBanner j={lastJudged} tally={personTally} /> : undefined}
      />
    </div>
  );
}
