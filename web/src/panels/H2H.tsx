// Mode 2: "Jev vs Gemini — same parcel, same question". A pure comparison: both models get the same
// photo, declared contents and four option texts at the same moment; no thresholds, no lanes.
// Every number on this page comes from the server's h2h_answer / h2h_result / h2h_stats events.
import * as React from "react";
import { Check, Loader2, X, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActionTag, LiveBadge, Panel, RoleDot } from "@/components/bits";
import { fmtUsd, type H2HRow, type State } from "@/state";
import type { CalibrationBin, H2HBoard, H2HSide, H2HSideStats } from "@/types";

const OPTIONS = ["ship", "retape", "hold", "return"];

type SideKey = "jev" | "gemini" | "gemma";
const SIDE: Record<SideKey, { name: string; role: SideKey; conf: string; confShort: string; via: string }> = {
  jev: { name: "Jev", role: "jev", conf: "probability", confShort: "calibrated", via: " · typesafe-sdk" },
  gemini: { name: "Gemini", role: "gemini", conf: "confidence stated by the LLM", confShort: "stated by the LLM", via: " · ADK LlmAgent gemini_reflex" },
  gemma: { name: "Gemma 4", role: "gemma", conf: "token probability (raw)", confShort: "raw token probability", via: " · /v1/systemone" },
};
// literal class names per side (Tailwind needs them spelled out)
const STY: Record<SideKey, { border: string; soft: string; ink: string; bar: string; spin: string; fill: string }> = {
  jev: { border: "border-jev/50", soft: "bg-jev-soft", ink: "text-jev-ink", bar: "bg-jev", spin: "text-jev", fill: "fill-jev/70" },
  gemini: { border: "border-gemini/50", soft: "bg-gemini-soft", ink: "text-gemini-ink", bar: "bg-gemini", spin: "text-gemini", fill: "fill-gemini/70" },
  gemma: { border: "border-gemma/50", soft: "bg-gemma-soft", ink: "text-gemma-ink", bar: "bg-gemma", spin: "text-gemma", fill: "fill-gemma/70" },
};

const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(d)}%`);
const sec = (ms: number | null | undefined) => (ms === null || ms === undefined ? "–" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const usd1k = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`);

function Outcome({ o, className }: { o: H2HSide["outcome"] | undefined; className?: string }) {
  if (!o) return null;
  const map = {
    correct: { t: "CORRECT", icon: Check, cls: "bg-success-muted text-success-foreground border-success/50" },
    safe: { t: "SAFE (held)", icon: AlertTriangle, cls: "bg-warning-muted text-warning-foreground border-warning/50" },
    wrong: { t: "WRONG", icon: X, cls: "bg-error-muted text-error-foreground border-error/50" },
    near_miss: { t: "NEAR-MISS SHIP", icon: X, cls: "bg-error text-white border-error" },
  }[o];
  const Icon = map.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[16px] font-bold tracking-wide", map.cls, className)}>
      <Icon className="size-4" strokeWidth={3} /> {map.t}
    </span>
  );
}

/** "Gemini · 3.2 s and counting" while the belt waits for Gemini (A12). */
function Counting() {
  const [t0] = React.useState(() => Date.now());
  const [now, setNow] = React.useState(t0);
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return (
    <span data-testid="gemini-counting" className="font-mono text-[26px] font-semibold tabular-nums text-gemini-ink">
      Gemini · {((now - t0) / 1000).toFixed(1)} s and counting
    </span>
  );
}

function SideCard({ k, side, waiting, truth, model, compact = false }: { k: SideKey; side?: H2HSide; waiting: boolean; truth?: string; model?: string | null; compact?: boolean }) {
  const meta = SIDE[k];
  const st = STY[k];
  const probs = side?.probabilities ?? {};
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col rounded-xl border-2 bg-card shadow-xs", st.border)}>
      <header className={cn("flex h-[48px] shrink-0 items-center gap-2.5 rounded-t-[10px] px-4", st.soft)}>
        <RoleDot role={meta.role} />
        <h3 className={cn("whitespace-nowrap text-[22px] font-bold", st.ink)}>{meta.name}</h3>
        <span className="truncate font-mono text-[15px] text-muted-foreground" title={`${model ?? ""}${meta.via}`}>
          {model ?? ""}
          {compact ? "" : meta.via}
        </span>
        <span className="ml-auto">
          <LiveBadge live={side?.live} />
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {!side ? (
          <div className="flex h-full items-center justify-center gap-2 text-[20px] text-muted-foreground">
            {waiting ? (
              <>
                <Loader2 className={cn("size-6 animate-spin", st.spin)} /> {k === "gemini" ? <Counting /> : `${meta.name} is deciding…`}
              </>
            ) : (
              "waiting for a parcel"
            )}
          </div>
        ) : side.error ? (
          <div className="rounded-lg bg-error-muted p-3 text-[17px] text-error-foreground">no answer: {side.error}</div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <ActionTag action={side.action ?? undefined} className="px-3 py-1 text-[26px]" />
              <Outcome o={side.outcome} />
            </div>
            <div className={cn("flex justify-between gap-3 whitespace-nowrap", compact ? "flex-wrap items-baseline gap-y-1" : "items-end")}>
              <div className={compact ? "w-full" : undefined}>
                <div className="text-[15px] text-muted-foreground">answer in</div>
                <div className={cn("font-mono text-[34px] font-bold leading-none tabular-nums", st.ink)}>{sec(side.ms)}</div>
              </div>
              <div>
                <div className="text-[15px] text-muted-foreground">{compact ? "tokens" : "tokens in / out"}</div>
                <div className="font-mono text-[19px] font-semibold tabular-nums">
                  {side.tokens_in?.toLocaleString() ?? "–"} / {side.tokens_out?.toLocaleString() ?? "–"}
                </div>
              </div>
              <div>
                <div className="text-[15px] text-muted-foreground">cost</div>
                <div className="font-mono text-[19px] font-semibold tabular-nums">{fmtUsd(side.cost)}</div>
              </div>
            </div>
            <div className="space-y-1">
              {OPTIONS.map((o) => {
                const v = probs[o] ?? 0;
                const chosen = o === side.action;
                return (
                  <div key={o} className="flex items-center gap-2 text-[17px]">
                    <span className={cn("font-mono", compact ? "w-[58px] text-[15px]" : "w-[64px]", chosen && "font-bold")}>{o}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full rounded-full", st.bar, !chosen && "opacity-45", truth === o && "ring-2 ring-foreground ring-inset")} style={{ width: `${Math.min(1, v) * 100}%` }} />
                    </div>
                    <span className={cn("text-right font-mono tabular-nums", compact ? "w-[44px] text-[15px]" : "w-[52px]")}>{v.toFixed(2)}</span>
                    {truth === o ? <span className={cn("text-[14px] font-semibold", compact ? "w-[28px]" : "w-[40px]")}>key</span> : <span className={compact ? "w-[28px]" : "w-[40px]"} />}
                  </div>
                );
              })}
            </div>
            <div className="flex items-baseline gap-2 text-[17px]">
              <span className={cn("text-muted-foreground", compact && "text-[15px]")}>{meta.conf}:</span>
              <b className="font-mono text-[22px] tabular-nums">{side.p_chosen?.toFixed(2) ?? "–"}</b>
            </div>
            {k === "gemini" && side.reason && <p className="line-clamp-2 text-[17px] italic leading-snug text-muted-foreground">“{side.reason}”</p>}
          </>
        )}
      </div>
    </section>
  );
}

function MetricRow({ label, cols, vals, better, big = false }: { label: React.ReactNode; cols: SideKey[]; vals: Partial<Record<SideKey, string>>; better?: SideKey | null; big?: boolean }) {
  const three = cols.length > 2;
  return (
    <tr className="border-b last:border-0">
      <td className={cn("py-1 pr-2", big ? "text-[22px] font-semibold text-foreground" : "text-[20px] text-muted-foreground", three && big && "text-[19px]")}>{label}</td>
      {cols.map((k) => (
        <td key={k} className={cn("py-1 pl-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap", STY[k].ink, big ? (three ? "text-[24px]" : "text-[30px]") : three ? "text-[18px]" : "text-[22px]", better === k && "underline decoration-2 underline-offset-4")}>
          {vals[k] ?? "–"}
        </td>
      ))}
    </tr>
  );
}

/** The side with the smallest value, or null when tied / missing. */
function best(cols: SideKey[], v: (k: SideKey) => number | null | undefined, wantLow = true): SideKey | null {
  const xs = cols.map((k) => [k, v(k)] as const).filter((x): x is readonly [SideKey, number] => x[1] != null);
  if (xs.length < cols.length) return null;
  const top = wantLow ? Math.min(...xs.map((x) => x[1])) : Math.max(...xs.map((x) => x[1]));
  const at = xs.filter((x) => x[1] === top);
  return at.length === 1 ? at[0][0] : null;
}

function acc(st: H2HSideStats) {
  return `${st.correct}/${st.parcels} · ${pct(st.accuracy)}`;
}

/** Reliability diagram: x = the probability a model gave its own choice, y = how often it was right. */
function Calibration({ bins, k, size = 230 }: { bins: CalibrationBin[]; k: SideKey; size?: number }) {
  const W = size;
  const H = Math.round(size * 0.8);
  const L = 44;
  const B = 24;
  const T = 16;
  const R = 18;
  const LO = 0.25;
  const x = (v: number) => L + ((v - LO) / (1 - LO)) * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - B - T);
  const maxN = Math.max(1, ...bins.map((b) => b.n));
  return (
    <div className="flex flex-col">
      <span className={cn("text-[20px] font-semibold", STY[k].ink)}>
        {SIDE[k].name} · {SIDE[k].confShort}
      </span>
      <svg width={W} height={H + 20} className="block overflow-visible">
        <rect x={L} y={T} width={W - L - R} height={H - B - T} className="fill-muted" rx={4} />
        <line x1={x(LO)} y1={y(LO)} x2={x(1)} y2={y(1)} stroke="var(--muted-foreground)" strokeDasharray="4 4" />
        {[0, 0.5, 1].map((t) => (
          <text key={t} x={L - 5} y={y(t) + 5} textAnchor="end" style={{ fontSize: 13 }} className="fill-muted-foreground">
            {t.toFixed(1)}
          </text>
        ))}
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" style={{ fontSize: 13 }} className="fill-muted-foreground">
            {t.toFixed(2)}
          </text>
        ))}
        <text x={(L + W - R) / 2} y={H + 14} textAnchor="middle" style={{ fontSize: 18, fontWeight: 600 }} className="fill-foreground">
          said
        </text>
        <text x={10} y={(T + H - B) / 2} textAnchor="middle" transform={`rotate(-90 10 ${(T + H - B) / 2})`} style={{ fontSize: 18, fontWeight: 600 }} className="fill-foreground">
          right
        </text>
        {bins
          .filter((b) => b.n > 0 && b.mean_p !== null && b.accuracy !== null)
          .map((b) => (
            <g key={b.lo}>
              <circle cx={x(Math.max(LO, b.mean_p!))} cy={y(b.accuracy!)} r={5 + 9 * Math.sqrt(b.n / maxN)} className={STY[k].fill} stroke="white" strokeWidth={1.5} />
              <text x={x(Math.max(LO, b.mean_p!))} y={y(b.accuracy!) + 4.5} textAnchor="middle" style={{ fontSize: 12, fontWeight: 700 }} className="pointer-events-none fill-white">
                {b.n}
              </text>
            </g>
          ))}
      </svg>
    </div>
  );
}

export function H2HScoreboard({ board, big = false, calib = false }: { board?: H2HBoard; big?: boolean; calib?: boolean }) {
  if (!board || !board.parcels) {
    return <p className="p-4 text-[20px] text-muted-foreground">The scoreboard fills in as the answers arrive for each parcel.</p>;
  }
  const cols: SideKey[] = board.gemma ? ["jev", "gemini", "gemma"] : ["jev", "gemini"];
  const st = (k: SideKey) => board[k] as H2HSideStats;
  const wait: Record<SideKey, number | null | undefined> = { jev: board.jev_wait_s, gemini: board.gemini_wait_s, gemma: board.gemma_wait_s };
  const accs = cols.map((k) => st(k).accuracy);
  const same = accs.every((a) => a !== null && a === accs[0]);
  const map = (f: (k: SideKey) => string) => Object.fromEntries(cols.map((k) => [k, f(k)])) as Partial<Record<SideKey, string>>;
  return (
    <div className={cn("flex min-h-0 flex-col gap-3", big ? "text-[20px]" : "")}>
      <table className="w-full">
        <thead>
          <tr className="border-b text-[18px]">
            <th className="pb-1 text-left font-medium text-muted-foreground">{board.parcels} parcels</th>
            {cols.map((k) => (
              <th key={k} className={cn("pb-1 pl-2 text-right font-bold whitespace-nowrap", STY[k].ink)}>{SIDE[k].name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <MetricRow big cols={cols} label="Belt would wait (s per parcel)" vals={map((k) => (wait[k] != null ? `${wait[k]} s` : "–"))} better={best(cols, (k) => wait[k])} />
          <MetricRow big cols={cols} label="Mean latency" vals={map((k) => sec(st(k).ms_mean))} better={best(cols, (k) => st(k).ms_mean)} />
          <MetricRow big cols={cols} label={board.gemma ? "Cost per 1k parcels*" : "Cost per 1k parcels"} vals={map((k) => usd1k(st(k).cost_per_1k))} better={best(cols, (k) => st(k).cost_per_1k)} />
          <MetricRow
            cols={cols}
            label={
              <>
                Accuracy vs answer key
                {same && <span data-testid="same-tag" className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[16px] font-semibold text-foreground">same</span>}
              </>
            }
            vals={map((k) => (cols.length > 2 ? `${st(k).correct}/${st(k).parcels}` : acc(st(k))))}
            better={same ? null : best(cols, (k) => st(k).accuracy, false)}
          />
          <tr className="border-b last:border-0">
            <td className="py-1 pr-2 text-[20px] text-muted-foreground">Agreement <span className="text-[16px]">(Jev · Gemini)</span></td>
            <td colSpan={cols.length} className="py-1 text-right font-mono text-[20px] font-semibold tabular-nums">
              {pct(board.agreement_rate)} <span className="text-[17px] font-medium text-muted-foreground">({board.agree}/{board.both_answered})</span>
            </td>
          </tr>
        </tbody>
      </table>
      {board.gemma && (
        <p className="text-[14px] leading-snug text-muted-foreground">
          * Gemma: GPU time at ${board.prices.gemma_per_hour ?? 1.42}/h (one L4 on Cloud Run, billed while the instance is up), not per token.
        </p>
      )}
      {calib && (
        <div data-testid="calibration-block">
          <div className="mb-1 text-[22px] font-semibold">Calibration: does 0.9 mean right 9 in 10?</div>
          <div className="flex justify-between gap-2">
            {cols.map((k) =>
              board.calibration[k] ? <Calibration key={k} bins={board.calibration[k]!} k={k} size={cols.length > 2 ? (big ? 250 : 180) : big ? 330 : 236} /> : null,
            )}
          </div>
          <p className="mt-1 text-[16px] leading-snug text-muted-foreground">On the dashed line = calibrated. Dot size = parcels. Small n: read the dots, not the decimals.</p>
        </div>
      )}
    </div>
  );
}

function RecentRow({ r, onInspect, cols }: { r: H2HRow; onInspect: (id: string) => void; cols: SideKey[] }) {
  const cell = (k: SideKey) => {
    const sd = r[k];
    if (!sd) return r.done ? <span className="text-muted-foreground">–</span> : <Loader2 className={cn("size-4 animate-spin", STY[k].spin)} />;
    const ok = sd.outcome === "correct";
    return (
      <button className="flex items-center gap-1.5 font-mono" onClick={() => sd.call_id && onInspect(sd.call_id)} title="inspect this call">
        <span className={cn("font-semibold uppercase", STY[k].ink)}>{sd.action ?? "–"}</span>
        {sd.outcome && (ok ? <Check className="size-4 text-success-foreground" strokeWidth={3} /> : <X className={cn("size-4", sd.outcome === "safe" ? "text-warning-foreground" : "text-error-foreground")} strokeWidth={3} />)}
        <span className="text-muted-foreground">{sec(sd.ms)}</span>
      </button>
    );
  };
  return (
    <tr className="border-b text-[16px] last:border-0">
      <td className="py-1 font-mono">{r.id}</td>
      <td className="py-1 font-mono uppercase">{r.truth ?? "…"}</td>
      {cols.map((k) => (
        <td key={k} className="py-1">{cell(k)}</td>
      ))}
      <td className="py-1 text-right">{r.done ? (r.agree ? <span className="text-success-foreground">agree</span> : <b className="text-error-foreground">differ</b>) : ""}</td>
    </tr>
  );
}

function LatencyStrip({ s, cols }: { s: State; cols: SideKey[] }) {
  const rows = s.h2h.order.map((id) => s.h2h.rows[id]).filter((r) => r?.done);
  const maxMs = Math.max(1000, ...rows.map((r) => Math.max(...cols.map((k) => r[k]?.ms ?? 0))));
  const total = rows.length ? rows[0] && (s.parcels[rows[0].id]?.total ?? rows.length) : 30;
  const slot = 100 / Math.max(total, rows.length, 1);
  return (
    <div className="relative h-full">
      <div className="absolute inset-0 flex items-end gap-0">
        {rows.map((r) => (
          <div key={r.id} className="flex h-full items-end justify-center gap-[2px]" style={{ width: `${slot}%` }} title={`${r.id}: ` + cols.map((k) => `${SIDE[k].name} ${sec(r[k]?.ms)}`).join(" · ")}>
            {cols.map((k) => (
              <div key={k} className={cn("rounded-t-sm", STY[k].bar, cols.length > 2 ? "w-[28%]" : "w-[38%]")} style={{ height: `${Math.max(1.5, ((r[k]?.ms ?? 0) / maxMs) * 100)}%`, minHeight: 3 }} />
            ))}
          </div>
        ))}
      </div>
      <span className="absolute right-0 top-0 rounded bg-card/80 px-1 font-mono text-[13px] text-muted-foreground">top = {sec(maxMs)}</span>
    </div>
  );
}

export function H2HView({ s, onInspect, calib = false }: { s: State; onInspect: (id: string) => void; calib?: boolean }) {
  const cur = s.currentId ? s.parcels[s.currentId] : undefined;
  const row = cur ? s.h2h.rows[cur.id] : undefined;
  const opts = s.policy?.options ?? {};
  const recent = s.h2h.order
    .slice(-9)
    .reverse()
    .map((id) => s.h2h.rows[id])
    .filter(Boolean);
  const both = row?.jev && row?.gemini;
  const withGemma = !!s.h2h.gemmaModel;
  const cols: SideKey[] = withGemma ? ["jev", "gemini", "gemma"] : ["jev", "gemini"];
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex h-[64px] shrink-0 items-center gap-5 rounded-xl border bg-card px-5 shadow-xs">
        <h2 className="whitespace-nowrap text-[30px] font-bold tracking-tight">
          <span className="text-jev-ink">Jev</span> vs <span className="text-gemini-ink">Gemini</span>
          {withGemma && (
            <>
              {" "}vs <span className="text-gemma-ink">Gemma 4</span>
            </>
          )}{" "}
          <span className="text-muted-foreground">—</span> same parcel, same question
        </h2>
        <p className="text-[17px] leading-snug text-muted-foreground">
          Same photo, same declared contents, same four option texts, sent at the same moment. No thresholds, no lanes: each model&apos;s own top choice, graded against the answer key.
        </p>
      </div>
      <div className={cn("grid min-h-0 flex-1 gap-3", withGemma ? "grid-cols-[380px_minmax(0,1fr)_560px]" : "grid-cols-[440px_minmax(0,1fr)_600px]")}>
        {/* the parcel and the question both got */}
        <Panel title="The parcel" aside={cur ? <span className="font-mono">{cur.id} · {cur.index}/{cur.total}</span> : undefined} bodyClassName="flex flex-col gap-3 p-3">
          <div className={cn("relative shrink-0 overflow-hidden rounded-lg border bg-muted", withGemma ? "h-[300px]" : "h-[340px]")}>
            {cur ? <img src={cur.photo_url} alt={`parcel ${cur.id}`} className="size-full object-cover" /> : <div className="grid size-full place-items-center text-[18px] text-muted-foreground">press START</div>}
            {row?.truth && (
              <span className="absolute bottom-2 left-2 rounded-md bg-foreground px-2.5 py-1 font-mono text-[18px] font-bold uppercase text-background">answer key: {row.truth}</span>
            )}
          </div>
          <div className="text-[19px]">
            <span className="text-muted-foreground">Declared:</span> <b>{cur?.declared || "–"}</b>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted/40 p-3">
            <div className="mb-1 text-[15px] font-semibold text-muted-foreground">The question {withGemma ? "all three" : "both"} got (policy v{s.policyVersion})</div>
            <p className="text-[15px] leading-snug">What should the sorter do?</p>
            <ul className="mt-1 space-y-1">
              {OPTIONS.map((o) => (
                <li key={o} className="text-[14px] leading-snug">
                  <b className="font-mono">{o}</b> <span className="text-muted-foreground">{opts[o] ?? ""}</span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>

        {/* both answers, side by side */}
        <div className="flex min-h-0 flex-col gap-3">
          <div className={cn("relative grid h-[480px] shrink-0 gap-3", withGemma ? "grid-cols-3" : "grid-cols-2")}>
            <SideCard k="jev" side={row?.jev} waiting={!!cur && !row?.jev} truth={row?.truth} model={s.h2h.jevModel} compact={withGemma} />
            <SideCard k="gemini" side={row?.gemini} waiting={!!cur && !row?.gemini} truth={row?.truth} model={s.h2h.geminiModel} compact={withGemma} />
            {withGemma && <SideCard k="gemma" side={row?.gemma} waiting={!!cur && !row?.gemma && !row?.done} truth={row?.truth} model={s.h2h.gemmaModel} compact />}
            {both && row?.done && !withGemma && (
              <span
                className={cn(
                  withGemma ? "left-1/3" : "left-1/2",
                  "absolute bottom-4 -translate-x-1/2 rounded-full border-2 px-4 py-1 text-[20px] font-bold shadow-sm",
                  row.agree ? "border-success bg-success-muted text-success-foreground" : "border-error bg-error-muted text-error-foreground",
                )}
              >
                {row.agree ? "AGREE" : "DISAGREE"}
              </span>
            )}
          </div>
          <Panel title="Answer latency per parcel" aside={<span><RoleDot role="jev" className="size-2.5" /> Jev · <RoleDot role="gemini" className="size-2.5" /> Gemini{withGemma && <> · <RoleDot role="gemma" className="size-2.5" /> Gemma</>} · same clock</span>} className="h-[120px] shrink-0" bodyClassName="px-4 py-2">
            <LatencyStrip s={s} cols={cols} />
          </Panel>
          <Panel title="Recent parcels" className="min-h-0 flex-1" bodyClassName="overflow-hidden px-4 py-1">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-[15px] text-muted-foreground">
                  <th className="py-1 font-medium">parcel</th>
                  <th className="py-1 font-medium">key</th>
                  <th className="py-1 font-medium">Jev</th>
                  <th className="py-1 font-medium">Gemini</th>
                  {withGemma && <th className="py-1 font-medium">Gemma</th>}
                  <th className="py-1 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <RecentRow key={r.id} r={r} onInspect={onInspect} cols={cols} />
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        {/* the running scoreboard */}
        <Panel title="Scoreboard" aside={<span>{s.running ? "running" : s.h2h.board ? "final" : ""}</span>} bodyClassName="overflow-hidden p-4">
          <H2HScoreboard board={s.h2h.board} calib={calib && !s.running && !!s.h2h.board} />
          {s.h2h.prices && (
            <p className="mt-1 truncate text-[13px] text-muted-foreground" title={s.h2h.prices.gemini_source}>
              Per 1M tokens: Jev ${s.h2h.prices.jev_in_per_m} in, output free · Gemini ${s.h2h.prices.gemini_in_per_m} in / ${s.h2h.prices.gemini_out_per_m} out (
              {s.h2h.prices.gemini_source.startsWith("published") ? "published price; Vertex assumed equal" : "assumed"})
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
