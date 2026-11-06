// The Safety view (mode 3, key G): the gate's per-action bars, which check fired for each parcel,
// the audit sample, the drift alarm and the calibration result. Numbers from GET /api/safety and the stream.
import * as React from "react";
import { AlertTriangle, RotateCcw, ShieldCheck, Siren } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BeltApi } from "@/api";
import type { SafetyState } from "@/types";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { LANE, ROLE } from "@/components/bits";
import { RULE_LABEL, type State } from "@/state";

const f2 = (v: number | null | undefined) => (typeof v === "number" ? v.toFixed(2) : "–");
const pct = (v: number | null | undefined) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "–");

function Block({ title, children, className, aside }: { title: React.ReactNode; children: React.ReactNode; className?: string; aside?: React.ReactNode }) {
  return (
    <section className={cn("flex min-h-0 flex-col rounded-xl border bg-card p-3 shadow-xs", className)}>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[19px] font-semibold">{title}</h3>
        <div className="ml-auto text-[15px] text-muted-foreground">{aside}</div>
      </div>
      {children}
    </section>
  );
}

export function DriftBadge({ state, className }: { state: string; className?: string }) {
  if (state === "normal") return null;
  return (
    <span className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 font-mono text-[17px] font-bold text-background", state === "paused" ? "animate-pulse bg-error-foreground" : "bg-error", className)}>
      <Siren className="size-5" /> DRIFT: {state === "paused" ? "AUTO-SHIP PAUSED" : "BARS TIGHTENED"}
    </span>
  );
}

export function SafetyView({ api, s, open, onOpenChange }: { api: BeltApi; s: State; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [d, setD] = React.useState<SafetyState | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    api.getSafety().then((x) => {
      setD(x);
      setErr(null);
    }, (e) => setErr((e as Error).message));
  }, [api]);
  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [open, s.safetyTick, load]);
  const reset = () => api.setSafety({ reset_drift: true }).then(setD).catch((e) => setErr((e as Error).message));

  const th = d?.thresholds;
  const eff = d?.effective;
  const drift = d?.drift.state ?? s.drift.state;
  const audit = d?.audit;
  const cal = d?.calibration;
  // per-parcel rows: the run on this page, else the server's routes of the last run
  const ids = s.order.filter((id) => s.parcels[id]?.rule).length ? s.order.filter((id) => s.parcels[id]?.rule) : Object.keys(d?.routes ?? {});
  const audits = Object.fromEntries((d?.audits ?? []).map((a) => [a.parcel_id, a]));
  const caught = ids.filter((id) => {
    const p = s.parcels[id];
    const r = d?.routes[id];
    return (p?.legacyLane ?? r?.legacy_lane) === "auto" && (p?.lane ?? r?.lane) !== "auto" && !p?.escalatedFrom;
  }).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="safety-view" className="flex h-[94vh] w-[96vw] max-w-[96vw] flex-col gap-3 bg-background p-5 sm:max-w-[96vw]">
        <div className="flex items-center gap-4 pr-10">
          <DialogTitle className="flex items-center gap-2 text-[28px]">
            <ShieldCheck className="size-7 text-adk" /> Safety gate
          </DialogTitle>
          <DialogDescription className="text-[18px] text-muted-foreground">
            Confidence alone is not enough: a confidently wrong ship goes to a customer. Every check is plain code in the ADK gate.
          </DialogDescription>
          <DriftBadge state={drift} className="ml-auto" />
        </div>
        {err && <div className="rounded-md bg-error-muted px-3 py-1 text-[17px] text-error-foreground">GET /api/safety: {err}</div>}
        <div className="grid shrink-0 grid-cols-[1.15fr_0.9fr_1fr] gap-3">
          <Block title="Per-action bars" aside={d?.source}>
            <table className="w-full text-[17px]">
              <thead className="text-left text-[15px] text-muted-foreground">
                <tr>
                  <th>action</th>
                  <th>base</th>
                  <th>in force</th>
                  <th>context</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {(["ship", "retape", "hold"] as const).map((a) => (
                  <tr key={a} className="border-t">
                    <td className="py-0.5 font-semibold">{a}</td>
                    <td>≥ {f2(th?.[a])}</td>
                    <td className={cn(eff && th && eff[a] !== th[a] && "font-bold text-error-foreground")}>{eff?.paused && a !== "hold" ? "PAUSED" : `≥ ${f2(eff?.[a])}`}</td>
                    <td className="font-sans text-[15px]">
                      {a === "ship" && "fragile: never auto · high-value +0.05"}
                      {a === "retape" && "fragile +0.10 · high-value +0.05"}
                      {a === "hold" && "safe action: never tightened"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t">
                  <td className="py-0.5 font-semibold">return / refund</td>
                  <td colSpan={2} className="font-bold">never auto</td>
                  <td className="font-sans text-[15px]">irreversible, money: 2nd look or a person</td>
                </tr>
                <tr className="border-t">
                  <td className="py-0.5 font-semibold">human desk</td>
                  <td>&lt; {f2(th?.abstain)}</td>
                  <td />
                  <td className="font-sans text-[15px]">straight to a person</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-1.5 text-[15px] text-muted-foreground">
              Cross-check: ship/retape but P(damaged) ≥ {f2(d?.params.cross_damaged)} or risk ≥ {f2(d?.params.cross_risk)} → no auto. FRAGILE mark vs non-fragile contents → a person. Old gate for comparison: one bar,{" "}
              <b className="font-mono">auto ≥ {f2(d?.legacy.auto)}</b> for every action.
            </p>
          </Block>
          <Block
            title={<span className="flex items-center gap-2">Drift alarm</span>}
            className={cn(drift !== "normal" && "border-2 border-error bg-error-muted")}
            aside={
              <button onClick={reset} className="flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[15px] font-medium hover:bg-muted" data-testid="safety-reset-drift">
                <RotateCcw className="size-4" /> Reset
              </button>
            }
          >
            <div className={cn("text-[30px] font-bold uppercase", drift === "normal" ? "text-success-foreground" : "text-error-foreground")}>
              {drift}
              {d && d.drift.offset > 0 && <span className="ml-2 text-[20px]">bars +{d.drift.offset.toFixed(2)}</span>}
            </div>
            <p className="text-[15px] text-muted-foreground">
              Audited auto-lane mistakes over the budget (α = {pct(audit?.alpha)}) tighten the bars by {f2(d?.params.tighten_step)}; a second breach pauses auto-ship and auto-retape. Only a person relaxes it.
            </p>
            <ul className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-auto text-[15px]">
              {(d?.drift.history ?? []).slice().reverse().map((h, i) => (
                <li key={i} className="font-mono">
                  <b className="uppercase">{h.state}</b> <span className="font-sans">{h.reason}</span>
                </li>
              ))}
              {!d?.drift.history?.length && <li className="text-muted-foreground">no alarm this run</li>}
            </ul>
          </Block>
          <Block title="Audit sample (shadow 2nd look on auto parcels)" aside={audit ? `rate ${pct(audit.rate)}` : ""}>
            <div className="grid grid-cols-4 gap-2">
              {[
                ["audited", audit?.n ?? 0],
                ["running", audit?.pending ?? 0],
                ["Gemini flagged", audit?.flagged ?? 0],
                ["confirmed mistakes", audit?.errors ?? 0],
              ].map(([l, v]) => (
                <div key={l as string}>
                  <div className="text-[14px] leading-tight text-muted-foreground">{l}</div>
                  <div className={cn("text-[28px] font-bold tabular-nums", l === "confirmed mistakes" && Number(v) > 0 && "text-error-foreground")}>{v}</div>
                </div>
              ))}
            </div>
            <div className="mt-1 text-[18px]">
              Observed auto-lane error: <b className="font-mono">{pct(audit?.observed_error)}</b>
              <span className="text-muted-foreground"> · 95% upper bound </span>
              <b className="font-mono">{pct(audit?.ucb95)}</b>
              <span className="text-muted-foreground"> (n = {audit?.n ?? 0})</span>
            </div>
            <p className="text-[14px] text-muted-foreground">Label: {audit?.label_source ?? "–"}; a person's review of a flagged audit replaces it.</p>
            <div className="mt-1 rounded-md border border-dashed px-2 py-1 text-[15px]">
              <b>Demo only</b>: the answer key checked every auto parcel: {d?.auto_key.errors ?? 0} mistake(s) in {d?.auto_key.n ?? 0}. Production only sees the audits.
            </div>
          </Block>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-3">
          <Block title="Every route this run" aside={<span>old gate would have auto-decided <b className="text-error-foreground">{caught}</b> that the new gate escalated</span>}>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full text-[16px]">
                <thead className="sticky top-0 bg-card text-left text-[14px] text-muted-foreground">
                  <tr>
                    <th>parcel</th>
                    <th>Jev</th>
                    <th>conf</th>
                    <th>tier</th>
                    <th>rule fired</th>
                    <th>lane</th>
                    <th>old gate</th>
                    <th>final</th>
                    <th>audit</th>
                  </tr>
                </thead>
                <tbody>
                  {ids.map((id) => {
                    const p = s.parcels[id];
                    const r = d?.routes[id];
                    const lane = p?.lane ?? r?.lane;
                    const legacy = p?.legacyLane ?? r?.legacy_lane;
                    const rule = p?.rule ?? r?.rule;
                    const a = audits[id];
                    const escalated = legacy === "auto" && lane !== "auto";
                    return (
                      <tr key={id} className={cn("border-t", escalated && "bg-human-soft", a?.error && "bg-error-muted")}>
                        <td className="py-0.5 font-mono">{id}</td>
                        <td className="font-mono uppercase">{p?.jev?.model_choice ?? p?.jev?.action ?? ""}</td>
                        <td className="font-mono tabular-nums">{f2(p?.jev?.confidence)}</td>
                        <td>{p?.tier ?? r?.tier}</td>
                        <td className="font-mono text-[15px]" title={RULE_LABEL[rule ?? ""] ?? ""}>
                          {rule}
                        </td>
                        <td className={cn("font-semibold", lane && ROLE[LANE[lane].role].text)}>
                          {lane ? LANE[lane].title : ""}
                          {p?.escalatedFrom && " (via 2nd look)"}
                        </td>
                        <td className={cn(escalated && "font-bold text-error-foreground")}>{legacy ? LANE[legacy].title : ""}</td>
                        <td className="font-mono uppercase">{p?.final?.replace("_", " ") ?? ""}</td>
                        <td className="text-[15px]">{a ? (a.status !== "done" ? "running" : `${a.gemini_action ?? "?"}${a.flagged ? " ⚑" : ""}${a.error ? " MISTAKE" : ""}`) : ""}</td>
                      </tr>
                    );
                  })}
                  {!ids.length && (
                    <tr>
                      <td colSpan={9} className="py-3 text-muted-foreground">
                        No routes yet: start a run.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[14px]">
              {Object.entries(d?.rules ?? {})
                .sort((x, y) => y[1] - x[1])
                .map(([k, v]) => (
                  <span key={k} className="rounded border bg-muted/60 px-1.5 font-mono">
                    {k} <b>{v}</b>
                  </span>
                ))}
            </div>
          </Block>
          <Block title="Calibration: bars from data, not feel" aside={cal ? `${cal.source ?? ""} · n=${cal.n} · α=${pct(cal.alpha)}` : ""}>
            {cal ? (
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
                <table className="w-full text-[16px]">
                  <thead className="text-left text-[14px] text-muted-foreground">
                    <tr>
                      <th>action</th>
                      <th>n</th>
                      <th>data pick</th>
                      <th>floor</th>
                      <th>in force</th>
                      <th>covered</th>
                      <th>errors</th>
                      <th>risk</th>
                      <th>UCB95</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {Object.entries(cal.per_action).map(([a, r]) => (
                      <tr key={a} className="border-t">
                        <td className="py-0.5 font-semibold">{a}</td>
                        <td>{r.n_choice}</td>
                        <td>{f2(r.data_bar)}</td>
                        <td>{f2(r.floor)}</td>
                        <td className="font-bold">{f2(r.in_force)}</td>
                        <td>{r.covered}</td>
                        <td>{r.errors}</td>
                        <td>{pct(r.risk)}</td>
                        <td>{pct(r.ucb95)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="grid grid-cols-2 gap-2 text-[16px]">
                  <div className="rounded-md bg-jev-soft px-2 py-1">
                    New gate on the set: auto <b>{pct(cal.gate.coverage)}</b>, {cal.gate.auto_errors} harmful mistake(s) in the auto lane (UCB95 {pct(cal.gate.auto_ucb95)})
                  </div>
                  <div className="rounded-md bg-muted px-2 py-1">
                    Old single bar: auto <b>{pct(cal.legacy.coverage)}</b>, {cal.legacy.auto_errors} harmful mistake(s)
                  </div>
                </div>
                <p className="flex gap-2 text-[15px] leading-snug">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <span>{cal.note}</span>
                </p>
              </div>
            ) : (
              <p className="text-[17px] text-muted-foreground">No belt/calibration.json: the design bars are in force. Run scripts/calibrate_gate.py.</p>
            )}
          </Block>
        </div>
      </DialogContent>
    </Dialog>
  );
}
