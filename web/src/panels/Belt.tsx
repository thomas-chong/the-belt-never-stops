import { ArrowDown, Loader2, Hand } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActionTag, LANE, LiveBadge, Panel, ROLE, RoleDot } from "@/components/bits";
import { fmtMs, laneSummaries, RULE_LABEL, type ParcelState, type State } from "@/state";
import { AccentBar, GateButton, StatusPill } from "@/components/workflow/gate";
import { DESK_ACTIONS } from "@/panels/HumanTeacher";
import type { Lane, Thresholds } from "@/types";

const PROB_ORDER = ["ship", "retape", "hold", "return", "file_claim", "spot_check"];
const rank = (k: string) => {
  const i = PROB_ORDER.indexOf(k);
  return i < 0 ? 99 : i;
};

export function ConfidenceBar({ value, t }: { value?: number; t: Thresholds }) {
  const v = value ?? 0;
  const lane: Lane = v >= t.auto ? "auto" : v < t.abstain ? "human" : "gemini";
  return (
    <div>
      <div className="flex items-baseline justify-between text-[18px]">
        <span className="font-medium">confidence</span>
        <b className={cn("font-mono text-[24px] tabular-nums", ROLE[LANE[lane].role].text)}>{value === undefined ? "–" : v.toFixed(2)}</b>
      </div>
      <div className="relative mt-1 h-5 rounded-full bg-muted">
        <div className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-300", ROLE[LANE[lane].role].bar)} style={{ width: `${v * 100}%` }} />
        {[
          { at: t.abstain, label: "desk", cls: "text-human-ink" },
          { at: t.ship ?? t.auto, label: "ship", cls: "text-jev-ink" },
        ].map((m) => (
          <div key={m.label} className="absolute -top-1 -bottom-1 w-[3px] rounded bg-foreground" style={{ left: `calc(${m.at * 100}% - 1.5px)` }}>
            <span className={cn("absolute top-6 -translate-x-1/2 whitespace-nowrap font-mono text-[14px] font-semibold", m.cls)}>
              {m.label} {m.at.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Intake({ s, p, onInspect }: { s: State; p?: ParcelState; onInspect: (id: string) => void }) {
  const probs = p?.jev?.probabilities ?? {};
  const keys = Object.keys(probs)
    .filter((k) => k !== "damaged")
    .sort((a, b) => rank(a) - rank(b));
  return (
    <div className="grid grid-cols-[300px_minmax(0,1fr)] gap-4 p-3">
      <button
        className="relative h-[220px] overflow-hidden rounded-lg border bg-muted text-left"
        onClick={() => p?.jev && onInspect(p.jev.call_id)}
        title="open this call in the Inspector"
      >
        {p ? <img src={p.photo_url} alt={`parcel ${p.id}`} className="size-full object-cover" /> : <div className="grid size-full place-items-center text-[18px] text-muted-foreground">waiting for the first parcel</div>}
        {p && (
          <span className="absolute left-2 top-2 rounded-md bg-card/90 px-2 py-0.5 font-mono text-[16px] font-semibold">
            {p.id} · {p.index}/{p.total}
          </span>
        )}
      </button>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="truncate text-[20px]">
          <span className="text-muted-foreground">Declared:</span> <b>{p?.declared || "–"}</b>
          {p?.fragile && <span className="ml-2 rounded bg-error-muted px-1.5 text-[15px] font-semibold text-error-foreground">FRAGILE</span>}
        </div>
        <div className="flex h-7 items-center gap-1.5 whitespace-nowrap">
          {p?.jev ? (
            <>
              <span className="rounded-md bg-jev px-2 py-0.5 font-mono text-[16px] font-semibold text-white">
                Jev {Math.round(p.jev.ms)} ms · {p.jev.tokens_in} tok
              </span>
              <span className="rounded-md border px-1.5 py-0.5 font-mono text-[15px]">policy v{p.jev.policy_version ?? p.policyVersion}</span>
              <LiveBadge live={p.jev.live} />
            </>
          ) : (
            <span className="text-[17px] text-muted-foreground">{p ? "Jev is looking…" : ""}</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-0.5">
          {(keys.length ? keys : ["ship", "retape", "hold", "return"]).map((k) => (
            <div key={k} className="flex items-center gap-2 text-[17px]">
              <span className={cn("w-[84px] font-mono", p?.jev?.action === k && "font-bold")}>{k.replace("_", " ")}</span>
              <div className="h-3 flex-1 rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-[width] duration-300", p?.jev?.action === k ? "bg-jev" : "bg-jev/35")} style={{ width: `${(probs[k] ?? 0) * 100}%` }} />
              </div>
              <span className="w-[44px] text-right font-mono tabular-nums text-[16px]">{probs[k] !== undefined ? probs[k].toFixed(2) : ""}</span>
            </div>
          ))}
        </div>
        <ConfidenceBar value={p?.jev?.confidence} t={s.thresholds} />
        <div className="mt-4 flex min-w-0 items-center gap-2 whitespace-nowrap text-[18px]">
          <ArrowDown className="size-5 text-adk" />
          {p?.lane ? (
            <>
              <span className="shrink-0 font-semibold" data-testid="lane-result">
                {LANE[p.lane].title}
                {p.rule && RULE_LABEL[p.rule] && !p.rule.startsWith("auto_") ? ` · ${RULE_LABEL[p.rule]}` : ""}
              </span>
              {p.rule && (
                <span className="min-w-0 shrink truncate font-mono text-[13px] text-muted-foreground" title={RULE_LABEL[p.rule] ?? p.rule} data-testid="route-rule">
                  {p.rule}
                </span>
              )}
              {p.legacyLane && p.legacyLane !== p.lane && !p.escalatedFrom && (
                <span className="rounded border border-error/50 px-1.5 font-mono text-[14px] text-error-foreground" title="what the old single-threshold gate would have done">
                  old: {LANE[p.legacyLane].title}
                </span>
              )}
              <span className="truncate text-muted-foreground">· {p.reason}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{p ? "Jev is looking…" : "ADK routes each parcel on Jev's confidence"}</span>
          )}
        </div>
      </div>
    </div>
  );
}

const SHORT: Record<string, string> = { file_claim: "CLAIM", issue_refund: "REFUND", spot_check: "SPOT", return: "RETURN" };

function DeskCard({ p, waiting, onDecide, onReview }: { p: ParcelState; waiting: number; onDecide: (pid: string, action: string) => void; onReview: (pid: string) => void }) {
  return (
    <div className="lane-in relative flex w-[440px] shrink-0 flex-col justify-center gap-1.5 self-stretch overflow-hidden rounded-lg border-2 border-human bg-human-soft/60 py-1.5 pl-3 pr-2">
      <AccentBar status="waiting" className="w-1.5" />
      <button className="flex items-center gap-2 whitespace-nowrap text-left" onClick={() => onReview(p.id)} title="open the review (photo large, Jev, rule)" data-testid="desk-card">
        <img src={p.photo_url} alt="" className="h-7 w-9 rounded border object-cover" />
        <span className="font-mono text-[17px] font-bold">{p.id}</span>
        <span className="truncate text-[16px]">{p.humanKind === "audit" ? "audit · " : ""}{p.declared}</span>
        <span className="ml-auto">
          <StatusPill status="waiting" label={waiting > 1 ? `review · ${waiting - 1} more` : "review"} />
        </span>
      </button>
      <div className="flex gap-1.5">
        {DESK_ACTIONS.map((a) => (
          <GateButton key={a.action} tone="neutral" className="h-9 flex-1 px-1.5 text-[17px]" onClick={() => onDecide(p.id, a.action)}>
            <kbd>{a.key}</kbd> {a.label}
          </GateButton>
        ))}
      </div>
    </div>
  );
}

function Chip({ p, active, onClick }: { p: ParcelState; active: boolean; onClick: () => void }) {
  const pending = p.final === undefined;
  const lane = p.lane ?? "auto";
  return (
    <button
      onClick={onClick}
      className={cn(
        "lane-in relative flex w-[112px] shrink-0 flex-col overflow-hidden rounded-lg border bg-card text-left shadow-xs",
        pending && lane === "human" && "border-human border-2",
        pending && lane === "gemini" && "border-gemini border-2",
        active && "ring-2 ring-foreground",
      )}
      title={`${p.id} · ${p.declared}${p.rule ? ` · rule ${p.rule}` : ""}${p.legacyLane && p.legacyLane !== p.lane ? ` · old gate: ${p.legacyLane}` : ""}`}
    >
      <img src={p.photo_url} alt="" className="h-[52px] w-full object-cover" />
      <div className="flex items-center gap-1 px-1.5 py-1">
        <span className="font-mono text-[14px] font-semibold">{p.id.replace(/^P-0*/, "#")}</span>
        {p.jev && p.jev.policy_version !== undefined && p.jev.policy_version > 1 && (
          <span className="rounded bg-gemini-soft px-1 font-mono text-[12px] font-semibold text-gemini-ink">v{p.jev.policy_version}</span>
        )}
        <span className="ml-auto">
          {pending ? (
            lane === "human" ? <Hand className="size-4 text-human-ink" /> : <Loader2 className="size-4 animate-spin text-gemini" />
          ) : (
            <span className="font-mono text-[13px] font-bold uppercase">{SHORT[p.final!] ?? p.final!.replace("_", " ").slice(0, 7)}</span>
          )}
        </span>
      </div>
    </button>
  );
}

export function Belt({
  s,
  onInspect,
  onSelect,
  onDecide,
  onReview,
  selected,
  title = "The belt",
}: {
  s: State;
  onInspect: (id: string) => void;
  onSelect: (pid: string) => void;
  onDecide: (pid: string, action: string) => void;
  onReview: (pid: string) => void;
  selected?: string;
  title?: string;
}) {
  const deskId = s.humanQueue[0];
  const lanes = laneSummaries(s);
  const p = s.currentId ? s.parcels[s.currentId] : undefined;
  return (
    <Panel
      title={title}
      aside={<span>{s.order.length ? `${s.order.length} parcels this run` : "press START"}</span>}
      className="h-full"
      bodyClassName="flex flex-col"
    >
      <Intake s={s} p={p} onInspect={onInspect} />
      <div className="flex min-h-0 flex-1 flex-col gap-2 border-t bg-muted/40 p-3">
        {(["auto", "gemini", "human"] as Lane[]).map((l) => {
          const meta = LANE[l];
          const sum = lanes[l];
          const desk = l === "human" && deskId && s.parcels[deskId] ? s.parcels[deskId] : undefined;
          const ids = sum.ids.filter((id) => id !== desk?.id).slice(-9).reverse();
          return (
            <div key={l} className={cn("flex min-h-0 flex-1 items-stretch gap-3 rounded-lg border bg-card", ROLE[meta.role].border)}>
              <div className={cn("flex w-[210px] shrink-0 flex-col justify-center rounded-l-lg px-3", ROLE[meta.role].soft)}>
                <div className="flex items-center gap-2">
                  <RoleDot role={meta.role} />
                  <span className="text-[21px] font-semibold leading-tight">{meta.title}</span>
                </div>
                <span className="text-[16px] text-muted-foreground">{meta.who}</span>
                <div className="flex items-baseline gap-2">
                  <span className={cn("text-[28px] font-bold tabular-nums leading-none", ROLE[meta.role].text)}>{sum.count}</span>
                  <span className="text-[16px] tabular-nums text-muted-foreground">avg {fmtMs(sum.avgMs)}</span>
                </div>
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden py-1.5 pr-2">
                {desk && <DeskCard p={desk} waiting={s.humanQueue.length} onDecide={onDecide} onReview={onReview} />}
                {ids.length === 0 && !desk && <span className="text-[17px] text-muted-foreground">{l === "human" ? "Jev unsure: a person decides, Gemini is not asked" : "no parcels yet"}</span>}
                {ids.map((id) => (
                  <Chip key={id} p={s.parcels[id]} active={selected === id} onClick={() => (s.humanQueue.includes(id) ? onReview(id) : onSelect(id))} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export { ActionTag };
