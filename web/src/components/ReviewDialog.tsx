// Review pop-up: the parcel large, everything the floor knows about it, and the four decisions.
// Used by the Human desk in mode 3 and by mode 1 (You sort). Keys: S R H X decide, ←/→ move, Esc closes.
import * as React from "react";
import { ChevronLeft, ChevronRight, Eye, ShieldAlert, Sparkles, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RULE_LABEL } from "@/state";
import type { GateCheck, SecondLookVerdict } from "@/types";

export const REVIEW_ACTIONS: { action: string; key: string; label: string; hint: string }[] = [
  { action: "ship", key: "S", label: "Ship", hint: "send it on" },
  { action: "retape", key: "R", label: "Retape", hint: "tape, then send" },
  { action: "hold", key: "H", label: "Hold", hint: "a person checks" },
  { action: "return", key: "X", label: "Return", hint: "back to sender" },
];

export interface ReviewItem {
  id: string;
  photo_url: string;
  declared: string;
  handling?: string;
  jev?: { probabilities?: Record<string, number>; confidence?: number; damaged?: number; risk?: number; model_choice?: string; action?: string };
  secondLook?: SecondLookVerdict | null;
  rule?: string;
  reason?: string;
  checks?: GateCheck[];
  kind?: "decide" | "audit";
  autoAction?: string | null;
  /** Gemini's second look was asked, and it sent the parcel on to a person */
  escalated?: boolean;
  /** the answer key (shown only to the presenter: ?presenter=1 or K) */
  truth?: string | null;
}

/** After a person decides: their answer against the answer key, plus the running tally. */
export function JudgedBanner({ j, tally }: { j: { id: string; action: string; truth: string | null }; tally: { right: number; total: number } }) {
  const ok = j.truth ? j.truth === j.action : null;
  return (
    <div
      data-testid="judged-banner"
      className={cn(
        "flex items-center gap-4 rounded-xl border-2 px-5 py-2.5 text-[24px] shadow-xl",
        ok === null ? "border-border bg-card" : ok ? "border-success bg-success-muted" : "border-error bg-error-muted",
      )}
    >
      <span className="font-mono">{j.id}</span>
      <span>
        you: <b className="uppercase">{j.action}</b>
      </span>
      <span>
        answer key: <b className="uppercase">{j.truth ?? "none"}</b>
      </span>
      {ok !== null && <b className={ok ? "text-success-foreground" : "text-error-foreground"}>{ok ? "✓ right" : "✗ wrong"}</b>}
      {tally.total > 0 && (
        <span className="text-[19px] text-muted-foreground">
          person so far {tally.right}/{tally.total}
        </span>
      )}
    </div>
  );
}

/** Plain words for the safety checks a person may see (rule ids stay as a small mono suffix). */
export const PLAIN_CHECK: Record<string, string> = {
  marks_vs_declared: "FRAGILE mark, but the declared contents are not fragile",
  fragile_no_auto_ship: "fragile parcels never ship without a person",
  cross_check_disagree: "Jev's damage or risk score is high",
  return_never_auto: "return and refund never go auto",
};

/** The review pop-up's first line (A7): why a person sees this parcel, in one plain sentence. */
export function plainFirstLine(item: ReviewItem, abstain = 0.4): string {
  const conf = typeof item.jev?.confidence === "number" ? item.jev.confidence.toFixed(2) : "?";
  if (item.kind === "audit") return "Spot audit: Jev already decided this one alone. Was it right?";
  if (item.escalated) return `Jev was not sure enough (${conf}), and Gemini's second look was unsure too. A person decides.`;
  if (item.rule === "abstain_low_confidence") return `Jev was unsure (${conf}, under the ${abstain.toFixed(2)} bar). A person decides.`;
  if (item.rule) return `A safety check fired: ${PLAIN_CHECK[item.rule] ?? `(${item.rule})`}. A person decides.`;
  return "A person decides.";
}

const PROB_ORDER = ["ship", "retape", "hold", "return"];

function Zoomable({ src, alt }: { src: string; alt: string }) {
  const [zoom, setZoom] = React.useState(1);
  const [off, setOff] = React.useState({ x: 0, y: 0 });
  const drag = React.useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  React.useEffect(() => {
    setZoom(1);
    setOff({ x: 0, y: 0 });
  }, [src]);
  return (
    <div
      data-testid="review-photo"
      className={cn("relative h-full w-full touch-none select-none overflow-hidden rounded-xl bg-foreground/90", zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in")}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y, moved: false };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
        if (zoom > 1 && d.moved) setOff({ x: d.ox + dx, y: d.oy + dy });
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) {
          if (zoom > 1) {
            setZoom(1);
            setOff({ x: 0, y: 0 });
          } else setZoom(2);
        }
      }}
    >
      <img src={src} alt={alt} draggable={false} className="size-full object-contain transition-transform duration-150" style={{ transform: `translate(${off.x}px, ${off.y}px) scale(${zoom})` }} />
      <span className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md bg-card/90 px-2.5 py-1 text-[16px] font-medium">
        {zoom > 1 ? <ZoomOut className="size-4" /> : <ZoomIn className="size-4" />}
        {zoom > 1 ? "2x · drag to pan · click for 1x" : "click to zoom 2x"}
      </span>
    </div>
  );
}

export function ReviewDialog({
  open,
  item,
  onClose,
  onDecide,
  onPrev,
  onNext,
  position,
  note,
  jevNote,
  firstLine,
  showKey = false,
  onToggleKey,
  result,
}: {
  open: boolean;
  item?: ReviewItem;
  onClose: () => void;
  onDecide: (id: string, action: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
  position?: { index: number; total: number };
  /** a line under the title (e.g. "timer paused while the review is open") */
  note?: React.ReactNode;
  /** shown instead of Jev's numbers when Jev was not asked (mode 1) */
  jevNote?: string;
  /** mode 3: the plain first line (24 px) and the key line under it */
  firstLine?: string;
  /** show the ANSWER KEY chip on the photo (presenter=1, or toggled with K) */
  showKey?: boolean;
  /** K toggles the answer key chip while the pop-up is open */
  onToggleKey?: () => void;
  /** the graded result of the decision just made (shown above the next parcel) */
  result?: React.ReactNode;
}) {
  const ref = React.useRef({ item, onDecide, onPrev, onNext, onToggleKey });
  ref.current = { item, onDecide, onPrev, onNext, onToggleKey };
  React.useEffect(() => {
    if (!open) return;
    // capture phase: the page's own S/R/H/X hotkeys never see these keys while the review is open
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const r = ref.current;
      const a = REVIEW_ACTIONS.find((x) => x.key.toLowerCase() === k);
      if (a && r.item) {
        e.preventDefault();
        e.stopImmediatePropagation();
        r.onDecide(r.item.id, a.action);
      } else if (k === "k" && r.onToggleKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        r.onToggleKey();
      } else if (e.key === "ArrowLeft" && r.onPrev) {
        e.preventDefault();
        e.stopImmediatePropagation();
        r.onPrev();
      } else if (e.key === "ArrowRight" && r.onNext) {
        e.preventDefault();
        e.stopImmediatePropagation();
        r.onNext();
      } else if (k.length === 1) {
        e.stopImmediatePropagation(); // no mode switches / panels underneath
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const j = item?.jev;
  const probs = j?.probabilities ?? {};
  const fired = (item?.checks ?? []).filter((c) => c.fired);
  return (
    <Dialog open={open && !!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="review-dialog" className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-3 bg-card p-5 sm:max-w-[96vw]">
        {item && (
          <>
            <div className="flex items-center gap-4 pr-10">
              <DialogTitle className="flex items-center gap-3 text-[28px]">
                <Eye className="size-7 text-human-ink" /> Review <span className="font-mono">{item.id}</span>
              </DialogTitle>
              {item.kind === "audit" && (
                <span className="rounded-md bg-gemini-soft px-2.5 py-1 text-[17px] font-semibold text-gemini-ink">
                  shadow audit: Jev already decided {(item.autoAction ?? "?").toUpperCase()} alone; your answer becomes the audit label
                </span>
              )}
              <DialogDescription className="text-[17px] text-muted-foreground">{note}</DialogDescription>
              {position && (
                <div className="ml-auto flex items-center gap-2 text-[18px]">
                  <button className="rounded-md border p-1.5 hover:bg-muted disabled:opacity-30" onClick={onPrev} disabled={!onPrev} aria-label="previous waiting parcel">
                    <ChevronLeft className="size-6" />
                  </button>
                  <span className="font-mono tabular-nums">
                    {position.index} / {position.total} waiting
                  </span>
                  <button className="rounded-md border p-1.5 hover:bg-muted disabled:opacity-30" onClick={onNext} disabled={!onNext} aria-label="next waiting parcel">
                    <ChevronRight className="size-6" />
                  </button>
                </div>
              )}
            </div>
            {result && <div className="-mt-1 flex justify-center">{result}</div>}
            {firstLine && (
              <div data-testid="review-first-line" className="-mt-1">
                <p className="text-[24px] font-semibold leading-snug">{firstLine}</p>
                <p className="text-[20px] text-muted-foreground">
                  Press <kbd>S</kbd> ship · <kbd>R</kbd> retape · <kbd>H</kbd> hold · <kbd>X</kbd> return.
                </p>
              </div>
            )}
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_560px] gap-5">
              <div className={cn("relative min-h-0", firstLine ? "h-[72vh]" : "h-[80vh]")}>
                <Zoomable src={item.photo_url} alt={`parcel ${item.id}`} />
                {showKey && item.truth && (
                  <span data-testid="answer-key" className="pointer-events-none absolute left-3 top-3 rounded-md bg-foreground px-3 py-1.5 font-mono text-[24px] font-bold uppercase text-background shadow-lg">
                    ANSWER KEY: {item.truth}
                  </span>
                )}
              </div>
              <div className="flex min-h-0 flex-col gap-3">
                <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
                  <div className="rounded-lg border p-3">
                    <div className="text-[16px] text-muted-foreground">Declared contents</div>
                    <div className="text-[24px] font-semibold leading-tight">{item.declared || "–"}</div>
                    <div className="mt-1 text-[17px]">
                      <span className="text-muted-foreground">Marks on the box: </span>
                      {item.handling ? <b className="text-error-foreground">{item.handling}</b> : <span>none noted</span>}
                    </div>
                  </div>
                  {(item.rule || item.reason) && (
                    <div className="rounded-lg border border-adk/40 bg-adk-soft p-3">
                      <div className="flex items-center gap-2 text-[16px] text-muted-foreground">
                        <ShieldAlert className="size-4 text-adk" /> Why a person sees it
                      </div>
                      {item.rule && (
                        <div className="mt-0.5 flex items-baseline gap-2">
                          {RULE_LABEL[item.rule] && <span className="text-[18px] font-semibold">{RULE_LABEL[item.rule]}</span>}
                          <span className="font-mono text-[13px] text-muted-foreground" data-testid="review-rule-id">{item.rule}</span>
                        </div>
                      )}
                      {item.reason && <p className="mt-1 text-[17px] leading-snug">{item.reason}</p>}
                      {fired.length > 1 && (
                        <ul className="mt-1 space-y-0.5 text-[15px]">
                          {fired.map((c) => (
                            <li key={c.rule}>
                              {c.detail} <span className="font-mono text-[13px] text-muted-foreground">{c.rule} → {c.lane}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  <div className="rounded-lg border border-jev/40 p-3">
                    <div className="text-[16px] text-muted-foreground">Jev (System 1)</div>
                    {jevNote || !j ? (
                      <p className="text-[17px]">{jevNote ?? "Jev's answer is not in yet."}</p>
                    ) : (
                      <>
                        <div className="mt-1 space-y-1">
                          {PROB_ORDER.filter((k) => probs[k] !== undefined).map((k) => (
                            <div key={k} className="flex items-center gap-2 text-[18px]">
                              <span className={cn("w-[80px] font-mono", (j.model_choice ?? j.action) === k && "font-bold")}>{k}</span>
                              <div className="h-3.5 flex-1 rounded-full bg-muted">
                                <div className={cn("h-full rounded-full", (j.model_choice ?? j.action) === k ? "bg-jev" : "bg-jev/35")} style={{ width: `${(probs[k] ?? 0) * 100}%` }} />
                              </div>
                              <span className="w-[48px] text-right font-mono tabular-nums">{probs[k].toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                          {[
                            ["confidence", j.confidence],
                            ["P(damaged)", j.damaged],
                            ["risk 0-2", j.risk],
                          ].map(([l, v]) => (
                            <div key={l as string} className="rounded-md bg-muted/70 py-1">
                              <div className="text-[14px] text-muted-foreground">{l}</div>
                              <div className="font-mono text-[22px] font-semibold tabular-nums">{typeof v === "number" ? v.toFixed(2) : "–"}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {item.secondLook && (
                    <div className="rounded-lg border border-gemini/40 bg-gemini-soft/60 p-3">
                      <div className="flex items-center gap-2 text-[16px] text-muted-foreground">
                        <Sparkles className="size-4 text-gemini" /> Gemini 2nd look
                      </div>
                      <div className="text-[20px] font-semibold uppercase text-gemini-ink">
                        {item.secondLook.action ?? "–"}
                        {item.secondLook.needs_human && <span className="ml-2 text-[16px] normal-case">asks for a person</span>}
                      </div>
                      {item.secondLook.reason && <p className="text-[17px] leading-snug">{item.secondLook.reason}</p>}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  {REVIEW_ACTIONS.map((a) => (
                    <button
                      key={a.action}
                      data-testid={`review-${a.action}`}
                      onClick={() => onDecide(item.id, a.action)}
                      className="flex h-[76px] flex-col items-center justify-center rounded-xl border-2 border-foreground/80 bg-card text-[26px] font-bold leading-none hover:bg-foreground hover:text-background"
                    >
                      <span>
                        <kbd className="mr-2 text-[18px]">{a.key}</kbd>
                        {a.label}
                      </span>
                      <span className="mt-1 text-[14px] font-normal opacity-70">{a.hint}</span>
                    </button>
                  ))}
                </div>
                <p className="text-center text-[15px] text-muted-foreground">
                  <kbd>S</kbd> <kbd>R</kbd> <kbd>H</kbd> <kbd>X</kbd> decide · <kbd>←</kbd> <kbd>→</kbd> next waiting · <kbd>Esc</kbd> close
                </p>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
