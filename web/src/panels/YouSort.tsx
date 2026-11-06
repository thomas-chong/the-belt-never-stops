// Mode 1, "You sort": one person, one parcel at a time, a countdown that does not wait.
// Parcels come from GET /api/manifest; every choice is graded against the hidden key by POST /api/judge.
// At the end, POST /api/you/jev puts Jev on the same parcels (live by default) for the comparison.
import * as React from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Hand, Loader2, Pause, Play, RotateCcw, Timer, XCircle, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BeltApi } from "@/api";
import type { Mode, YouJevResult } from "@/types";
import { ReviewDialog, REVIEW_ACTIONS } from "@/components/ReviewDialog";
import { LANE } from "@/components/bits";
import { fmtMs } from "@/state";

interface Parcel {
  id: string;
  url: string;
  declared: string;
}
interface Result {
  id: string;
  action: string;
  outcome?: string;
  truth?: string;
  ms: number;
}

const OUTCOME: Record<string, { label: string; cls: string; good: boolean }> = {
  correct: { label: "RIGHT", cls: "bg-success-foreground text-background", good: true },
  safe: { label: "SAFE (held)", cls: "bg-human text-foreground", good: false },
  wrong: { label: "WRONG", cls: "bg-error-foreground text-background", good: false },
  near_miss: { label: "NEAR-MISS: damaged parcel shipped", cls: "bg-error-foreground text-background", good: false },
  missed: { label: "MISSED: went through", cls: "bg-muted-foreground text-background", good: false },
};
const SECS = [1, 1.5, 2, 3, 5];
const MODES: { mode: Mode; key: string; label: string }[] = [
  { mode: "you", key: "1", label: "Round 1 · You sort" },
  { mode: "h2h", key: "2", label: "Round 2 · Jev vs Gemini" },
  { mode: "workflow", key: "3", label: "Round 3 · The team" },
];

function Tag({ outcome, className }: { outcome?: string; className?: string }) {
  if (!outcome) return <span className={cn("font-mono text-muted-foreground", className)}>…</span>;
  const o = OUTCOME[outcome] ?? { label: outcome, cls: "bg-muted", good: false };
  return <span className={cn("whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[14px] font-semibold uppercase", o.cls, className)}>{outcome.replace("_", "-")}</span>;
}

export function YouSort({ api, onMode, credit }: { api: BeltApi; onMode: (m: Mode) => void; credit?: string }) {
  const params = React.useMemo(() => new URLSearchParams(location.search), []);
  // ?limit=8&sec=2 (fix-spec A2): unknown values fall back to 12 parcels and 2 s
  const limit = (() => {
    const n = Number(params.get("limit"));
    return Number.isInteger(n) && n >= 1 && n <= 30 ? n : 12;
  })();
  const [sec, setSec] = React.useState(() => {
    const v = Number(params.get("sec"));
    return Number.isFinite(v) && v > 0 && v <= 30 ? v : 2;
  });
  const [phase, setPhase] = React.useState<"ready" | "running" | "done">("ready");
  const [parcels, setParcels] = React.useState<Parcel[]>([]);
  const [idx, setIdx] = React.useState(0);
  const [results, setResults] = React.useState<Result[]>([]);
  const [left, setLeft] = React.useState(sec * 1000);
  const [paused, setPaused] = React.useState(false);
  const [review, setReview] = React.useState(false);
  const [feedback, setFeedback] = React.useState<Result | null>(null);
  const [jev, setJev] = React.useState<YouJevResult | null>(null);
  const [jevErr, setJevErr] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const shownAt = React.useRef(0);
  const pausedMs = React.useRef(0);
  const pauseStart = React.useRef<number | null>(null);
  const locked = React.useRef(false);
  const resultsRef = React.useRef<Result[]>([]);

  const cur = parcels[idx];
  const stopped = paused || review || !!feedback || phase !== "running";

  // pause bookkeeping: decision time excludes paused / review time
  React.useEffect(() => {
    if (phase !== "running") return;
    if (paused || review) pauseStart.current ??= performance.now();
    else if (pauseStart.current !== null) {
      pausedMs.current += performance.now() - pauseStart.current;
      pauseStart.current = null;
    }
  }, [paused, review, phase]);

  const show = (i: number) => {
    setIdx(i);
    setLeft(sec * 1000);
    shownAt.current = performance.now();
    pausedMs.current = 0;
    pauseStart.current = null;
    locked.current = false;
  };

  const start = async () => {
    setErr(null);
    try {
      const m = await api.manifest();
      const ps = m.parcels.slice(0, limit);
      setParcels(ps);
      resultsRef.current = [];
      setResults([]);
      setJev(null);
      setJevErr(null);
      setFeedback(null);
      setPaused(false);
      setPhase("running");
      show(0);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const finish = React.useCallback(
    (all: Result[]) => {
      setPhase("done");
      api
        .youJev(all.map((r) => r.id))
        .then(setJev)
        .catch((e) => setJevErr((e as Error).message));
    },
    [api],
  );

  const decide = React.useCallback(
    (action: string) => {
      if (phase !== "running" || !cur || locked.current) return;
      locked.current = true;
      setReview(false);
      const extra = pauseStart.current !== null ? performance.now() - pauseStart.current : 0;
      const ms = action === "missed" ? sec * 1000 : performance.now() - shownAt.current - pausedMs.current - extra;
      const r: Result = { id: cur.id, action, ms };
      setFeedback(r);
      const i = idx;
      api
        .judge(cur.id, action)
        .then((j) => {
          const done = { ...r, outcome: j.outcome, truth: j.truth };
          setFeedback(done);
          resultsRef.current = [...resultsRef.current, done];
        })
        .catch(() => {
          resultsRef.current = [...resultsRef.current, r];
        })
        .finally(() => {
          setResults(resultsRef.current);
          setTimeout(() => {
            setFeedback(null);
            if (i + 1 < parcels.length) show(i + 1);
            else finish(resultsRef.current);
          }, 750);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phase, cur, idx, parcels.length, sec, api, finish],
  );

  // countdown
  React.useEffect(() => {
    if (stopped) return;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setLeft((l) => Math.max(0, l - dt));
    }, 40);
    return () => clearInterval(t);
  }, [stopped]);
  React.useEffect(() => {
    if (!stopped && left <= 0) decide("missed");
  }, [left, stopped, decide]);

  // keys (the review dialog captures its own while open)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (phase !== "running") {
        if (k === "enter") return void start();
        const m = MODES.find((x) => x.key === k);
        if (m) onMode(m.mode);
        return;
      }
      if (k === " " || k === "p") {
        e.preventDefault();
        setPaused((p) => !p);
        return;
      }
      const a = REVIEW_ACTIONS.find((x) => x.key.toLowerCase() === k);
      if (a && !paused) decide(a.action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, paused, decide]);

  const scored = results.filter((r) => r.outcome);
  const correct = scored.filter((r) => r.outcome === "correct").length;
  let streak = 0;
  for (let i = results.length - 1; i >= 0 && results[i].outcome === "correct"; i--) streak++;
  const timed = results.filter((r) => r.action !== "missed");
  const avgMs = timed.length ? timed.reduce((a, r) => a + r.ms, 0) / timed.length : null;
  const frac = left / (sec * 1000);

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex h-[60px] shrink-0 items-center gap-5">
        <h1 className="whitespace-nowrap text-[32px] font-bold tracking-tight">Round 1 · You sort</h1>
        <span className="text-[20px] text-muted-foreground">one person, {sec} s per parcel, the belt does not wait</span>
        <nav className="ml-auto flex rounded-lg border bg-card p-1 shadow-xs">
          {MODES.map((m) => (
            <button
              key={m.mode}
              onClick={() => onMode(m.mode)}
              disabled={phase === "running"}
              className={cn("flex h-10 items-center gap-2 rounded-md px-3 text-[18px] font-medium disabled:opacity-40", m.mode === "you" ? "bg-foreground text-background [&_kbd]:bg-foreground [&_kbd]:text-background/80" : "hover:bg-muted")}
            >
              <kbd>{m.key}</kbd> {m.label}
            </button>
          ))}
        </nav>
        <label className="flex items-center gap-2 text-[18px]">
          <Timer className="size-5 text-muted-foreground" />
          <select value={sec} disabled={phase === "running"} onChange={(e) => setSec(Number(e.target.value))} className="h-12 rounded-lg border bg-card px-2 text-[18px]" title="seconds per parcel">
            {SECS.map((x) => (
              <option key={x} value={x}>
                {x} s / parcel
              </option>
            ))}
          </select>
        </label>
        {phase === "running" ? (
          <button onClick={() => setPaused((p) => !p)} className="flex h-12 w-[170px] items-center justify-center gap-2 rounded-lg border-2 border-foreground bg-card text-[22px] font-bold">
            {paused ? <Play className="size-5 fill-current" /> : <Pause className="size-5 fill-current" />} {paused ? "RESUME" : "PAUSE"}
          </button>
        ) : (
          <button data-testid="you-start" onClick={start} className="flex h-12 w-[170px] items-center justify-center gap-2 rounded-lg bg-foreground text-[22px] font-bold text-background">
            <Play className="size-5 fill-current" /> {phase === "done" ? "AGAIN" : "START"}
          </button>
        )}
      </header>

      {phase === "done" ? (
        <Summary results={results} parcels={parcels} jev={jev} jevErr={jevErr} avgMs={avgMs} onAgain={start} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px] gap-5">
          <div className="flex min-h-0 flex-col gap-3">
            {/* countdown */}
            <div className="flex h-[34px] shrink-0 items-center gap-3">
              <div className="relative h-5 flex-1 overflow-hidden rounded-full bg-muted" data-testid="you-countdown">
                <div className={cn("absolute inset-y-0 left-0 rounded-full", frac < 0.3 ? "bg-error" : "bg-jev")} style={{ width: `${(phase === "running" ? frac : 1) * 100}%` }} />
              </div>
              <span className="w-[110px] text-right font-mono text-[26px] font-bold tabular-nums">{phase === "running" ? `${(left / 1000).toFixed(1)} s` : `${sec.toFixed(1)} s`}</span>
            </div>
            <button
              className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border bg-foreground/90"
              onClick={() => cur && phase === "running" && setReview(true)}
              title="open the review (pauses the countdown)"
              data-testid="you-photo"
            >
              {cur && phase === "running" ? (
                <img src={cur.url} alt={`parcel ${cur.id}`} className="size-full object-contain" />
              ) : (
                <div className="grid size-full place-items-center text-[30px] text-background/80">{err ?? "Press START (or Enter). Keys S R H X decide, Space pauses."}</div>
              )}
              {cur && phase === "running" && (
                <span className="absolute left-4 top-4 rounded-lg bg-card/90 px-3 py-1 font-mono text-[22px] font-semibold">
                  {cur.id} · {idx + 1}/{parcels.length}
                </span>
              )}
              {paused && phase === "running" && (
                <div className="absolute inset-0 grid place-items-center bg-foreground/60 text-[48px] font-bold text-background">PAUSED · Space to resume</div>
              )}
              {feedback?.action === "missed" && (
                <div data-testid="you-missed-overlay" className="absolute inset-0 grid place-items-center bg-error/80 text-[64px] font-extrabold tracking-tight text-white">
                  MISSED · went through
                </div>
              )}
              {feedback && feedback.action !== "missed" && (
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-4 bg-card/95 py-5 text-[34px] font-bold">
                  {!feedback.outcome ? (
                    <Loader2 className="size-9 animate-spin" />
                  ) : OUTCOME[feedback.outcome]?.good ? (
                    <CheckCircle2 className="size-10 text-success-foreground" />
                  ) : (
                    <XCircle className="size-10 text-error-foreground" />
                  )}
                  <span className={cn("rounded-lg px-3 py-1", OUTCOME[feedback.outcome ?? ""]?.cls)}>{feedback.outcome ? OUTCOME[feedback.outcome]?.label ?? feedback.outcome : "grading…"}</span>
                  {feedback.truth && (
                    <span className="text-[26px] font-medium">
                      you: <b className="uppercase">{feedback.action}</b> · key: <b className="uppercase">{feedback.truth}</b>
                    </span>
                  )}
                </div>
              )}
            </button>
            <div className="shrink-0 truncate text-[30px]">
              <span className="text-muted-foreground">Declared:</span> <b>{phase === "running" ? cur?.declared : "–"}</b>
            </div>
          </div>
          <aside className="flex min-h-0 flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              {[
                ["score", `${correct} / ${results.length}`],
                ["streak", String(streak)],
                ["avg decision", fmtMs(avgMs)],
                ["missed", String(results.filter((r) => r.action === "missed").length)],
              ].map(([l, v]) => (
                <div key={l} className="rounded-xl border bg-card px-4 py-3 shadow-xs">
                  <div className="text-[17px] text-muted-foreground">{l}</div>
                  <div className="text-[36px] font-bold tabular-nums leading-tight">{v}</div>
                </div>
              ))}
            </div>
            <div className="grid flex-1 grid-rows-4 gap-3">
              {REVIEW_ACTIONS.map((a) => (
                <button
                  key={a.action}
                  data-testid={`you-${a.action}`}
                  disabled={phase !== "running" || paused || !!feedback}
                  onClick={() => decide(a.action)}
                  className="flex items-center gap-4 rounded-2xl border-2 border-foreground bg-card px-6 text-left text-[40px] font-bold hover:bg-foreground hover:text-background disabled:opacity-40"
                >
                  <kbd className="text-[26px]">{a.key}</kbd>
                  <span>{a.label}</span>
                  <span className="ml-auto text-[18px] font-normal opacity-70">{a.hint}</span>
                </button>
              ))}
            </div>
            <p className="text-[16px] text-muted-foreground">
              Click the photo to review it large (the countdown pauses while the review is open). <kbd>Space</kbd> pauses.
            </p>
          </aside>
        </div>
      )}
      <footer className="h-[22px] shrink-0 truncate text-[15px] text-muted-foreground">Photos: {credit || "credit line comes from the server"}</footer>

      <ReviewDialog
        open={review && phase === "running" && !!cur}
        item={cur ? { id: cur.id, photo_url: cur.url, declared: cur.declared } : undefined}
        onClose={() => setReview(false)}
        onDecide={(_id, action) => decide(action)}
        note="Countdown paused while the review is open (the time still counts in your decision time)."
        jevNote="Round 1: Jev is not asked while you sort. It answers the same parcels at the end."
      />
    </div>
  );
}

function Summary({ results, parcels, jev, jevErr, avgMs, onAgain }: { results: Result[]; parcels: Parcel[]; jev: YouJevResult | null; jevErr: string | null; avgMs: number | null; onAgain: () => void }) {
  const n = results.length;
  const count = (k: string) => results.filter((r) => r.outcome === k).length;
  const byId = Object.fromEntries((jev?.answers ?? []).map((a) => [a.id, a]));
  const urls = Object.fromEntries(parcels.map((p) => [p.id, p.url]));
  const js = jev?.summary;
  const [showTable, setShowTable] = React.useState(false);
  const card = (who: "you" | "jev") => {
    const rows =
      who === "you"
        ? [
            ["right", `${count("correct")} / ${n}`],
            ["near-miss ships", count("near_miss")],
            ["safe holds", count("safe")],
            ["wrong", count("wrong")],
            ["missed", results.filter((r) => r.action === "missed").length],
            ["avg decision", fmtMs(avgMs)],
          ]
        : js
          ? [
              ["right", `${js.correct} / ${js.n}`],
              ["near-miss ships", js.near_miss],
              ["safe holds", js.safe],
              ["wrong", js.wrong],
              ["errors", js.errors],
              ["avg decision", fmtMs(js.ms_avg)],
            ]
          : [];
    return (
      <div className={cn("rounded-xl border-2 bg-card p-4 shadow-xs", who === "you" ? "border-human" : "border-jev")}>
        <div className="flex items-center gap-2 text-[26px] font-bold">
          {who === "you" ? <Hand className="size-7 text-human-ink" /> : <Zap className="size-7 text-jev" />}
          {who === "you" ? "You" : "Jev, same parcels"}
        </div>
        {who === "jev" && <div className="text-[16px] text-muted-foreground" data-testid="jev-source">{jev ? `source: ${jev.source_label}` : jevErr ? `Jev failed: ${jevErr}` : "asking Jev…"}</div>}
        {who === "jev" && !jev && !jevErr && <Loader2 className="mt-4 size-8 animate-spin text-jev" />}
        <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1">
          {rows.map(([l, v]) => (
            <div key={l as string}>
              <div className="text-[16px] text-muted-foreground">{l}</div>
              <div className="text-[30px] font-bold tabular-nums leading-tight">{v}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="you-summary">
      <div className="flex items-center gap-4">
        <h2 className="text-[30px] font-bold">End of your shift: you vs Jev on the same {n} parcels</h2>
        <button onClick={onAgain} className="ml-auto flex h-12 items-center gap-2 rounded-lg border-2 border-foreground px-4 text-[20px] font-bold">
          <RotateCcw className="size-5" /> Run again
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {card("you")}
        {card("jev")}
      </div>
      <button
        data-testid="you-show-parcels"
        onClick={() => setShowTable((v) => !v)}
        className="flex h-11 items-center gap-2 self-start rounded-lg border px-4 text-[18px] font-medium hover:bg-muted"
        aria-expanded={showTable}
      >
        {showTable ? <ChevronDown className="size-5" /> : <ChevronRight className="size-5" />} {showTable ? "Hide parcels" : "Show parcels"}
      </button>
      {showTable && (
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card" data-testid="you-parcel-table">
        <table className="w-full text-[18px]">
          <thead className="sticky top-0 bg-muted text-left text-[16px] text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5">parcel</th>
              <th>key</th>
              <th>you</th>
              <th>your time</th>
              <th>Jev</th>
              <th>conf</th>
              <th>Jev outcome</th>
              <th>gate lane</th>
              <th>Jev call</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const a = byId[r.id];
              return (
                <tr key={r.id} className="border-t">
                  <td className="flex items-center gap-2 px-3 py-1">
                    <img src={urls[r.id]} alt="" className="h-9 w-12 rounded border object-cover" />
                    <span className="font-mono">{r.id}</span>
                  </td>
                  <td className="font-mono uppercase">{r.truth ?? "–"}</td>
                  <td>
                    <span className="mr-2 font-mono uppercase">{r.action}</span>
                    <Tag outcome={r.outcome} />
                  </td>
                  <td className="font-mono tabular-nums">{r.action === "missed" ? "–" : fmtMs(r.ms)}</td>
                  <td className="font-mono uppercase">{a?.choice ?? (a?.error ? "error" : "…")}</td>
                  <td className="font-mono tabular-nums">{a?.confidence?.toFixed(2) ?? ""}</td>
                  <td>{a && <Tag outcome={a.outcome} />}</td>
                  <td className="text-[16px]">{a?.lane ? LANE[a.lane].title : ""}</td>
                  <td className="font-mono text-[15px]">{a ? (a.live ? `LIVE ${a.ms ?? ""} ms` : "recorded") : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
