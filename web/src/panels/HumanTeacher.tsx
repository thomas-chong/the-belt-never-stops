import * as React from "react";
import { Check, GraduationCap, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Panel } from "@/components/bits";
import { GateButton } from "@/components/workflow/gate";
import type { ProposalState, State } from "@/state";
import type { Evidence, PolicyDiffRow, RejudgeResult, RejudgeRow, RejudgeSide } from "@/types";

export const DESK_ACTIONS: { action: string; key: string; label: string }[] = [
  { action: "ship", key: "S", label: "Ship" },
  { action: "retape", key: "R", label: "Retape" },
  { action: "hold", key: "H", label: "Hold" },
  { action: "return", key: "X", label: "Return" },
];

/** Word-level view of one option change: unchanged words plain, removed struck, added highlighted. */
function WordDiff({ before, after }: { before: string; after: string }) {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const head = b.slice(0, pre).join("");
  const removed = a.slice(pre, a.length - suf).join("");
  const added = b.slice(pre, b.length - suf).join("");
  const tail = b.slice(b.length - suf).join("");
  return (
    <p className="font-mono text-[16px] leading-snug">
      {head}
      {removed.trim() && <del className="bg-error-muted text-error-foreground decoration-error/60">{removed}</del>}
      {added.trim() && <ins className="bg-success-muted font-semibold text-success-foreground no-underline">{added}</ins>}
      {tail}
    </p>
  );
}

function diffRows(p: ProposalState): PolicyDiffRow[] | null {
  const d = p.diff;
  if (Array.isArray(d)) return d;
  if (d && typeof d === "object" && Array.isArray((d as { changes?: PolicyDiffRow[] }).changes)) return (d as { changes: PolicyDiffRow[] }).changes;
  return null;
}

/** ①②③ while the teacher runs (A9): each step ticks when its ADK node ends; seconds from the click. */
function TeachProgress({ s, startedAt, n }: { s: State; startedAt: number; n: number }) {
  const [now, setNow] = React.useState(Date.now());
  const doneAt = React.useRef<Record<string, number>>({});
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const ended = (node: string) => s.adk[node]?.phase === "end";
  const flags = [ended("teach_gather") || ended("teacher"), ended("teacher") || ended("teach_store"), ended("teach_store")];
  const steps = [`① Reading ${n} desk decision${n === 1 ? "" : "s"}`, "② Drafting one rule", "③ Ready"];
  flags.forEach((f, i) => {
    if (f && doneAt.current[i] === undefined) doneAt.current[i] = Date.now();
  });
  return (
    <ol data-testid="teach-progress" className="space-y-1.5">
      {steps.map((label, i) => {
        const done = flags[i];
        const active = !done && (i === 0 || flags[i - 1]);
        const secs = ((done ? doneAt.current[i] : now) - startedAt) / 1000;
        return (
          <li key={label} className={cn("flex items-center gap-2 text-[20px]", !done && !active && "text-muted-foreground")}>
            {done ? <Check className="size-6 text-success" strokeWidth={3} /> : active ? <Loader2 className="size-6 animate-spin text-gemini" /> : <span className="inline-block size-6" />}
            <span className={cn(done && "font-semibold")}>{label}</span>
            {(done || active) && <span className="ml-auto font-mono text-[18px] tabular-nums text-muted-foreground">{Math.max(0, secs).toFixed(1)} s</span>}
          </li>
        );
      })}
    </ol>
  );
}

function versionOf(p: ProposalState, s: State) {
  return p.approvedVersion ?? s.policyVersion;
}

/** One cited parcel before re-judge: the photo, what the person decided, the declared contents. */
function EvidenceCard({ e }: { e: Evidence }) {
  return (
    <figure data-testid="teach-evidence" className="flex w-[170px] shrink-0 flex-col gap-0.5">
      <div className="relative h-[120px] w-[170px] overflow-hidden rounded-md border bg-muted">
        {e.photo_url ? <img src={e.photo_url} alt={`parcel ${e.parcel_id}`} className="size-full object-cover" /> : <div className="grid size-full place-items-center text-[15px] text-muted-foreground">no photo</div>}
      </div>
      <figcaption className="leading-tight">
        <div className="text-[18px] font-semibold">
          Person: <span className="uppercase">{e.person_action ?? "–"}</span>
        </div>
        <div className="truncate text-[15px] text-muted-foreground" title={e.declared ?? ""}>
          {e.declared ?? ""}
        </div>
        <div className="font-mono text-[13px] text-muted-foreground">{e.parcel_id}</div>
      </figcaption>
    </figure>
  );
}

const LANE_CHIP: Record<string, { label: string; cls: string }> = {
  auto: { label: "auto", cls: "bg-jev-soft text-jev-ink border-jev/40" },
  gemini: { label: "2nd look", cls: "bg-gemini-soft text-gemini-ink border-gemini/40" },
  human: { label: "person", cls: "bg-human-soft text-human-ink border-human/40" },
};

function LaneChip({ lane }: { lane?: string }) {
  const c = LANE_CHIP[lane ?? ""] ?? { label: "no answer", cls: "bg-muted text-muted-foreground" };
  return <span data-testid="rejudge-lane" className={cn("shrink-0 rounded-full border px-3 py-0.5 text-[18px] font-semibold", c.cls)}>{c.label}</span>;
}

/** Confidence v1 (hollow) → v2 (filled) on a 0–1 track, with the desk bar marked. */
function ConfidenceTrack({ before, after, bar }: { before: RejudgeSide | null; after: RejudgeSide | null; bar: number }) {
  const at = (x: number) => `${Math.max(0, Math.min(1, x)) * 100}%`;
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-3 w-[180px] shrink-0 rounded-full bg-muted" title={`desk bar ${bar.toFixed(2)}`}>
        <div className="absolute inset-y-0 left-0 rounded-l-full bg-human/25" style={{ width: at(bar) }} />
        <div className="absolute -inset-y-1.5 w-0.5 bg-foreground" style={{ left: at(bar) }} />
        {before && <div className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-muted-foreground bg-card" style={{ left: at(before.confidence) }} />}
        {after && <div className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" style={{ left: at(after.confidence) }} />}
      </div>
      <span className="font-mono tabular-nums">
        {before ? before.confidence.toFixed(2) : "–"} → <b>{after ? after.confidence.toFixed(2) : "–"}</b>
      </span>
      <span className="text-muted-foreground">| desk bar {bar.toFixed(2)}</span>
    </div>
  );
}

/** One re-judged parcel as a row: photo, the person's answer, v1 → v2 answer and confidence, the lane after. */
function RejudgeLine({ e, row, rj }: { e: Evidence; row?: RejudgeRow; rj: RejudgeResult }) {
  const ans = (x: RejudgeSide | null | undefined, ok?: boolean) =>
    x ? (
      <span className={cn("font-semibold", ok ? "text-success-foreground" : "text-error-foreground")}>
        {x.action.toUpperCase()} {ok ? "✓" : "✗"}
      </span>
    ) : (
      <span className="text-muted-foreground">no answer</span>
    );
  return (
    <li data-testid="rejudge-row" className="flex items-start gap-3 rounded-md border px-2 py-1">
      <div className="mt-0.5 h-[48px] w-[64px] shrink-0 overflow-hidden rounded border bg-muted">
        {e.photo_url ? <img src={e.photo_url} alt={`parcel ${e.parcel_id}`} className="size-full object-cover" /> : null}
      </div>
      <div className="min-w-0 flex-1 text-[18px] leading-snug">
        <div className="flex items-center gap-x-3">
          <span>
            Person <b className="uppercase">{e.person_action ?? "–"}</b>
          </span>
          <span className="font-mono">
            v{rj.version_before} {ans(row?.before, row?.match_before)} → v{rj.version_after} {ans(row?.after, row?.match_after)}
          </span>
          <span className="ml-auto">
            <LaneChip lane={row?.after?.lane} />
          </span>
        </div>
        <ConfidenceTrack before={row?.before ?? null} after={row?.after ?? null} bar={rj.desk_bar ?? 0.4} />
        {row?.still_person_reason && <div className="text-muted-foreground">{row.still_person_reason}</div>}
      </div>
    </li>
  );
}

export function Teacher({
  s,
  busy,
  startedAt,
  onTeach,
  onApprove,
  onRejudge,
  rejudging,
  title = "Teacher",
  className,
}: {
  s: State;
  busy?: boolean;
  /** Date.now() when "Ask Gemini to teach" was pressed */
  startedAt?: number;
  onTeach: () => void;
  onApprove: (id: string) => void;
  onRejudge: (id: string) => void;
  rejudging?: boolean;
  title?: string;
  className?: string;
}) {
  const id = s.proposalOrder[s.proposalOrder.length - 1];
  const p = id ? s.proposals[id] : undefined;
  const teaching = busy || Object.values(s.calls).some((c) => c.agent === "teacher" && c.end === undefined);
  const rows = p ? diffRows(p) : null;
  const decidedN = s.order.filter((pid) => s.parcels[pid]?.humanAction && s.parcels[pid]?.humanKind !== "audit").length;
  const rj = p ? s.rejudge[p.proposal_id] : undefined;
  const byId = new Map((rj?.rows ?? []).map((r) => [r.parcel_id, r]));
  const evidence = p?.evidence ?? [];
  const showProgress = teaching && startedAt !== undefined;
  const summaryRef = React.useRef<HTMLParagraphElement>(null);
  React.useEffect(() => {
    if (rj) summaryRef.current?.scrollIntoView({ block: "nearest" });
  }, [rj]);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {title} <span className="text-[16px] font-normal text-muted-foreground">LLM teaches, Jev serves</span>
        </span>
      }
      role="gemini"
      aside={<span className="rounded border px-1.5 font-mono text-[16px] font-semibold text-foreground">policy v{s.policyVersion}</span>}
      className={cn("min-h-0 flex-1", className)}
      bodyClassName="flex flex-col gap-2 overflow-auto p-3"
    >
      {showProgress ? (
        <TeachProgress s={s} startedAt={startedAt!} n={decidedN} />
      ) : !p ? (
        <div className="flex flex-1 flex-col justify-between gap-2">
          <p className="text-[18px] text-muted-foreground">
            Gemini reads the parcels the desk decided and proposes one rule for Jev&apos;s policy. A person approves; Jev uses it on the very next parcel. No retraining.
          </p>
          <GateButton tone="neutral" icon={Sparkles} onClick={onTeach} disabled={teaching} className="self-start">
            Ask Gemini to teach
          </GateButton>
        </div>
      ) : p.status === "no_change" ? (
        <div className="flex flex-1 flex-col justify-between gap-2">
          <p data-testid="teach-no-change" className="text-[24px] font-semibold leading-snug">
            No change proposed: the policy already matches the desk.
          </p>
          <GateButton tone="neutral" icon={Sparkles} onClick={onTeach} disabled={teaching} className="self-start">
            Ask Gemini to teach
          </GateButton>
        </div>
      ) : (
        <>
          <p data-testid="teach-rule" className={cn("font-semibold leading-tight", rj ? "text-[22px]" : "text-[26px]")}>
            <GraduationCap className="mr-1.5 inline size-6 align-[-3px] text-gemini" />
            New rule: {p.rule_text || p.rationale}
          </p>
          {p.warnings && p.warnings.length > 0 && (
            <p data-testid="teach-warnings" className="rounded-md bg-warning-muted px-2 py-1 text-[18px] text-warning-foreground">
              Overlap: {p.warnings.join("; ")}
            </p>
          )}
          {rj && (
            <div ref={summaryRef} data-testid="rejudge-summary" className="space-y-1">
              <p className="text-[24px] font-semibold leading-tight">
                Answers: {rj.matches_before} → {rj.matches_after} of {rj.k} match
                {rj.left_desk_after !== undefined && (
                  <>
                    {" · "}Left the desk: {rj.left_desk_after} of {rj.k}
                  </>
                )}
              </p>
              {rj.left_desk_after === 0 && rj.matches_after > rj.matches_before && (
                <p data-testid="rejudge-honest" className="text-[20px] leading-snug">
                  Better answers, but Jev is still unsure. The gate keeps them with a person — that is the gate working.
                </p>
              )}
            </div>
          )}
          {rj && evidence.length > 0 ? (
            <ul className="space-y-1">
              {evidence.map((e) => (
                <RejudgeLine key={e.parcel_id} e={e} row={byId.get(e.parcel_id)} rj={rj} />
              ))}
            </ul>
          ) : evidence.length > 0 && (
            <div className="flex flex-wrap gap-2.5">
              {evidence.map((e) => (
                <EvidenceCard key={e.parcel_id} e={e} />
              ))}
            </div>
          )}
          <details className="rounded-md border px-2 py-1">
            <summary className="cursor-pointer text-[17px] font-medium text-muted-foreground">Show policy diff</summary>
            <div className="mt-1 space-y-1.5">
              {rows ? (
                rows.map((r) => (
                  <div key={r.option} className="rounded-md border px-2 py-1">
                    <div className="font-mono text-[15px] font-semibold text-muted-foreground">option: {r.option}</div>
                    <WordDiff before={r.before} after={r.after} />
                  </div>
                ))
              ) : (
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/60 p-2 font-mono text-[16px]">{typeof p.diff === "string" ? p.diff : JSON.stringify(p.diff, null, 2)}</pre>
              )}
              <p className="text-[15px] text-muted-foreground">{p.rationale}</p>
            </div>
          </details>
          {/* sticky so Approve / Re-judge never clip when 4 evidence tiles fill the panel */}
          <div className="sticky -bottom-3 -mx-3 mt-auto -mb-3 flex flex-wrap items-center gap-2 border-t bg-card px-3 py-2">
            {p.status === "approved" ? (
              <>
                <span data-testid="teach-applied" className="flex items-center gap-2 rounded-md bg-success-muted px-3 py-1.5 text-[18px] font-semibold text-success-foreground">
                  <Check className="size-5" /> Applied as policy v{versionOf(p, s)}
                </span>
                <GateButton tone="neutral" icon={rejudging ? Loader2 : RefreshCw} disabled={rejudging || !evidence.length} onClick={() => onRejudge(p.proposal_id)} className={cn(rejudging && "[&_svg]:animate-spin")}>
                  Re-judge these {evidence.length} parcels on v{versionOf(p, s)}
                </GateButton>
              </>
            ) : (
              <GateButton tone="approve" icon={p.status === "approving" ? Loader2 : Check} disabled={p.status === "approving"} onClick={() => onApprove(p.proposal_id)}>
                Approve → policy v{s.policyVersion + 1}
              </GateButton>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
