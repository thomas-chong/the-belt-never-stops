import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { ShieldAlert, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";
import { Metric, RoleDot } from "@/components/bits";
import { barFor, fmtMs, fmtUsd, jobTotals, modelTotals, type State } from "@/state";
import type { Lane, Thresholds } from "@/types";

/** What the bars alone would do with the parcels so far (per-action bar by Jev's own choice). The
 *  gate's context checks (cross-check, tiers, drift) can only send more parcels up, never fewer. */
function project(s: State, t: Thresholds): Record<Lane, number> {
  const out: Record<Lane, number> = { auto: 0, gemini: 0, human: 0 };
  for (const id of s.order) {
    const j = s.parcels[id]?.jev;
    if (j?.confidence === undefined) continue;
    const bar = barFor(t, j.model_choice ?? j.action);
    if (j.confidence < t.abstain) out.human++;
    else if (bar !== null && j.confidence >= bar) out.auto++;
    else out.gemini++;
  }
  return out;
}

export function ThresholdStrip({ s, onCommit, clean = false, title = "Gates" }: { s: State; onCommit: (t: Thresholds) => void; clean?: boolean; title?: string }) {
  const [draft, setDraft] = React.useState<Thresholds | null>(null);
  const t = draft ?? s.thresholds;
  const proj = project(s, t);
  const n = proj.auto + proj.gemini + proj.human;
  const pct = (k: Lane) => (n ? Math.round((proj[k] / n) * 100) : 0);
  const totals = modelTotals(s);
  const jobs = jobTotals(s);
  const blocked = s.stats?.blocked_tools ?? Object.values(s.tools).filter((x) => x.verdict && !x.verdict.allowed).length;
  const skippedN = Math.max(s.skipped.count, s.stats?.gemini_skipped ?? 0);
  const savedCost = Math.max(s.skipped.cost, s.stats?.saved_cost_est ?? 0);
  const savedMs = Math.max(s.skipped.ms, s.stats?.saved_ms_est ?? 0);
  const lo = Math.round(t.abstain * 100);
  const hi = Math.round(t.auto * 100);

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_370px_250px_240px_160px] gap-3">
      <section className="min-w-0 rounded-xl border bg-card px-5 py-2.5 shadow-xs">
        <div className="flex items-baseline gap-3">
          <RoleDot role="adk" />
          <h2 className="whitespace-nowrap text-[20px] font-semibold">{title}</h2>
          {s.drift.state !== "normal" && (
            <span className="whitespace-nowrap rounded bg-error-foreground px-1.5 font-mono text-[15px] font-bold text-background">DRIFT {s.drift.state.toUpperCase()}</span>
          )}
          <span className="ml-auto whitespace-nowrap font-mono text-[16px] tabular-nums" data-testid="gate-bars">
            {!clean && (
              <>
                <span className="text-human-ink">desk &lt; {t.abstain.toFixed(2)}</span>
                <span className="mx-1 text-muted-foreground">·</span>
              </>
            )}
            <span className="text-jev-ink">ship ≥ {(t.ship ?? t.auto).toFixed(2)}</span>
            <span className="mx-1 text-muted-foreground">·</span>
            <span className="text-jev-ink">retape ≥ {(t.retape ?? t.auto).toFixed(2)}</span>
            <span className="mx-1 text-muted-foreground">·</span>
            <span className="text-jev-ink">hold ≥ {(t.hold ?? t.auto).toFixed(2)}</span>
            <span className="mx-1 text-muted-foreground">·</span>
            <span className="text-gemini-ink">return never</span>
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-3">
        <SliderPrimitive.Root
          className="relative flex h-8 w-full min-w-0 flex-1 touch-none select-none items-center"
          min={0}
          max={100}
          step={1}
          minStepsBetweenThumbs={1}
          value={[lo, hi]}
          onValueChange={(v) => setDraft({ ...s.thresholds, abstain: v[0] / 100, auto: v[1] / 100, ship: v[1] / 100 })}
          onValueCommit={(v) => {
            const next = { ...s.thresholds, abstain: v[0] / 100, auto: v[1] / 100, ship: v[1] / 100 };
            setDraft(null);
            onCommit(next);
          }}
          aria-label="confidence thresholds"
        >
          {clean && (
            <div data-testid="gate-zones" className="pointer-events-none absolute inset-x-0 -top-0.5 z-10 flex h-8 items-center text-[17px] font-bold">
              <span className="truncate text-center text-foreground" style={{ width: `${lo}%` }}>Human desk &lt; {t.abstain.toFixed(2)}</span>
              <span className="truncate text-center text-white" style={{ width: `${hi - lo}%` }}>Second look</span>
            </div>
          )}
          <SliderPrimitive.Track className={cn("relative grow overflow-hidden rounded-full", clean ? "h-8" : "h-4")}>
            <div className="absolute inset-y-0 left-0 bg-human/70" style={{ width: `${lo}%` }} />
            <div className="absolute inset-y-0 bg-gemini/60" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
            <div className="absolute inset-y-0 right-0 bg-jev/70" style={{ width: `${100 - hi}%` }} />
            <SliderPrimitive.Range className="absolute h-full bg-transparent" />
          </SliderPrimitive.Track>
          {[0, 1].map((i) => (
            <SliderPrimitive.Thumb
              key={i}
              className="block size-7 rounded-full border-[3px] border-foreground bg-card shadow-md outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
              aria-label={i === 0 ? "human desk below" : "auto-ship at or above"}
            />
          ))}
        </SliderPrimitive.Root>
          {clean && (
            <span data-testid="gate-zone-auto" className="shrink-0 whitespace-nowrap text-[17px] font-bold text-jev-ink">
              Auto ≥ bar
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-[17px]">
          <span className="w-[250px] shrink-0 whitespace-nowrap text-muted-foreground">{n ? `${n} parcels so far would split` : "lane share appears with parcels"}</span>
          <div className="flex h-7 flex-1 overflow-hidden rounded-md bg-muted font-semibold text-[16px]">
            {(["human", "gemini", "auto"] as Lane[]).map((k) =>
              proj[k] ? (
                <div
                  key={k}
                  className={cn(
                    "flex items-center justify-center whitespace-nowrap transition-[width] duration-300",
                    k === "auto" && "bg-jev text-white",
                    k === "gemini" && "bg-gemini text-white",
                    k === "human" && "bg-human text-foreground",
                  )}
                  style={{ width: `${pct(k)}%` }}
                >
                  {pct(k) >= 12 ? `${k === "auto" ? "Auto" : k === "gemini" ? "2nd look" : "Desk"} ${pct(k)}%` : ""}
                </div>
              ) : null,
            )}
          </div>
        </div>
      </section>

      {/* like with like: a decision against a decision (Jev on every parcel, Gemini's 2nd look on unsure ones) */}
      <section className="rounded-xl border bg-card px-4 py-2.5 shadow-xs">
        <span className="whitespace-nowrap text-[15px] font-medium text-muted-foreground">Decision latency · like for like</span>
        <div className="grid grid-cols-2 gap-3 whitespace-nowrap">
          <Metric role="jev" label="Jev, every parcel" value={fmtMs(totals.jev.avgMs)} sub={`${totals.jev.calls} calls · ${fmtUsd(totals.jev.cost)}`} />
          <Metric role="gemini" label="Gemini 2nd look" value={fmtMs(jobs.decision.avgMs)} sub={`${jobs.decision.calls} calls · ${fmtUsd(jobs.decision.cost)}`} />
        </div>
      </section>
      <section className="rounded-xl border bg-card px-4 py-2.5 shadow-xs">
        <span className="flex items-center gap-1.5 text-[15px] font-medium text-muted-foreground">
          <span className="inline-block size-2.5 rounded-full" style={{ background: "var(--job-clerk)" }} /> Gemini work, not decisions
        </span>
        <div className="text-[26px] font-semibold leading-tight tabular-nums" style={{ color: "var(--job-clerk)" }}>
          {jobs.work.calls} <span className="text-[17px] font-medium text-muted-foreground">calls · {fmtUsd(jobs.work.cost)}</span>
        </div>
        <span className="text-[15px] text-muted-foreground">
          clerk {jobs.work.byJob.clerk} · report {jobs.work.byJob.report} · teacher {jobs.work.byJob.teacher}
        </span>
      </section>
      <section className="rounded-xl border bg-card px-4 py-3 shadow-xs">
        <span className="flex items-center gap-1.5 text-[15px] font-medium text-muted-foreground">
          <SkipForward className="size-4 text-jev" /> Gemini skipped
        </span>
        <div className="flex items-baseline gap-3">
          <span className="text-[26px] font-semibold tabular-nums text-jev-ink">{skippedN}</span>
          <span className="whitespace-nowrap text-[16px] tabular-nums">
            saved ≈ {fmtUsd(savedCost)} · {fmtMs(savedMs)}
          </span>
        </div>
        <span className="text-[15px] text-muted-foreground">estimate from 2nd-look calls</span>
      </section>
      <section className="rounded-xl border bg-card px-4 py-3 shadow-xs">
        <span className="flex items-center gap-1.5 text-[15px] font-medium text-muted-foreground">
          <ShieldAlert className="size-4 text-adk" /> Gate blocked
        </span>
        <span className={cn("text-[26px] font-semibold tabular-nums", blocked ? "text-error-foreground" : "text-adk-ink")}>{blocked}</span>
        <span className="block text-[15px] text-muted-foreground">
          desk waiting: <b className="text-human-ink">{s.stats?.human_pending ?? s.humanQueue.length}</b>
        </span>
      </section>
    </div>
  );
}
