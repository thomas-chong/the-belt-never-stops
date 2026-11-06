import * as React from "react";
import { Loader2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BeltApi } from "@/api";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ActionTag, Json, LiveBadge, RoleDot } from "@/components/bits";
import { fmtMs, fmtUsd, type State } from "@/state";
import { H2HScoreboard } from "@/panels/H2H";
import type { ContextResult, InspectRecord, Policy } from "@/types";

// ── Inspector ────────────────────────────────────────────────────────────

export function Inspector({
  api,
  s,
  open,
  onOpenChange,
  callId,
  setCallId,
}: {
  api: BeltApi;
  s: State;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  callId?: string;
  setCallId: (id: string) => void;
}) {
  const [rec, setRec] = React.useState<InspectRecord | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const call = callId ? s.calls[callId] : undefined;
  const callDone = call?.end !== undefined;

  React.useEffect(() => {
    if (!open || !callId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .inspect(callId)
      .then((r) => alive && setRec(r))
      .catch((e: Error) => alive && (setRec(null), setErr(e.message)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [api, open, callId, callDone]);

  const recent = s.callOrder.slice(-14).reverse();
  const live = (rec?.live as boolean | undefined) ?? call?.live;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[860px] gap-0 sm:max-w-[860px]">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="flex items-center gap-3 text-[24px]">
            Inspector
            {callId && <span className="font-mono text-[20px] text-muted-foreground">{callId}</span>}
            <LiveBadge live={live} />
          </SheetTitle>
          <SheetDescription className="text-[17px]">Verbatim request and response for one model call, from GET /api/inspect/{"{call_id}"}.</SheetDescription>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {recent.map((id) => {
              const c = s.calls[id];
              return (
                <button
                  key={id}
                  onClick={() => setCallId(id)}
                  className={cn("flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[14px]", id === callId ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}
                >
                  <RoleDot role={c?.kind === "jev" ? "jev" : "gemini"} className="size-2" />
                  {id}
                </button>
              );
            })}
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 py-4">
          {!callId && <p className="text-[18px] text-muted-foreground">Click a parcel, a timeline mark or a Gemini panel to inspect its call.</p>}
          {call && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[18px]">
              <span>
                <span className="text-muted-foreground">model </span>
                <b>{(rec?.model as string) ?? (call.kind === "jev" ? "Jev" : "Gemini")}</b>
              </span>
              {call.agent && (
                <span>
                  <span className="text-muted-foreground">agent </span>
                  <b className="font-mono">{call.agent}</b>
                </span>
              )}
              {call.parcel_id && (
                <span>
                  <span className="text-muted-foreground">parcel </span>
                  <b className="font-mono">{call.parcel_id}</b>
                </span>
              )}
              <span>
                <span className="text-muted-foreground">time </span>
                <b className="tabular-nums">{fmtMs(call.ms)}</b>
              </span>
              <span>
                <span className="text-muted-foreground">tokens </span>
                <b className="tabular-nums">
                  {call.tokens_in ?? "–"} in · {call.tokens_out ?? "–"} out
                </b>
              </span>
              <span>
                <span className="text-muted-foreground">cost </span>
                <b className="tabular-nums">{fmtUsd(call.cost)}</b>
              </span>
            </div>
          )}
          {loading && (
            <p className="flex items-center gap-2 text-[18px] text-muted-foreground">
              <Loader2 className="size-5 animate-spin" /> loading
            </p>
          )}
          {err && <p className="text-[18px] text-error-foreground">{err}</p>}
          {rec && (
            <>
              {typeof rec.note === "string" && <p className="rounded-md bg-muted px-3 py-2 text-[17px]">{rec.note}</p>}
              <div>
                <h3 className="mb-1 text-[18px] font-semibold">Request</h3>
                <Json value={rec.request ?? "(not recorded)"} />
              </div>
              <div>
                <h3 className="mb-1 text-[18px] font-semibold">Response</h3>
                <Json value={rec.response ?? "(not recorded)"} />
              </div>
              <details>
                <summary className="cursor-pointer text-[16px] text-muted-foreground">full record</summary>
                <Json value={rec} className="mt-2" />
              </details>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Context test ─────────────────────────────────────────────────────────

export function ContextTest({ api, open, onOpenChange, onInspect }: { api: BeltApi; open: boolean; onOpenChange: (o: boolean) => void; onInspect: (id: string) => void }) {
  const [a, setA] = React.useState("Paperback books, 3");
  const [b, setB] = React.useState("Glass vase, 2 pcs");
  const [res, setRes] = React.useState<ContextResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.contextTest({ a, b }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1180px] gap-5 bg-card p-7 sm:max-w-[1180px]">
        <DialogHeader>
          <DialogTitle className="text-[26px]">Context test</DialogTitle>
          <DialogDescription className="text-[18px]">Same photo · two declared contents · two Jev calls at once · same policy, same code.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-6">
          <div className="flex flex-col gap-3">
            <div className="h-[230px] overflow-hidden rounded-lg border bg-muted">{res?.url && <img src={res.url} alt="" className="size-full object-cover" />}</div>
            <label className="text-[17px] font-medium">
              A · declared contents
              <input className="mt-1 block h-11 w-full rounded-md border bg-background px-3 text-[18px]" value={a} onChange={(e) => setA(e.target.value)} />
            </label>
            <label className="text-[17px] font-medium">
              B · declared contents
              <input className="mt-1 block h-11 w-full rounded-md border bg-background px-3 text-[18px]" value={b} onChange={(e) => setB(e.target.value)} />
            </label>
            <Button size="lg" className="h-12 text-[18px]" onClick={run} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />} Run both
            </Button>
            {err && <p className="text-[17px] text-error-foreground">{err}</p>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            {(res?.sides ?? [{ tag: "A", declared: a }, { tag: "B", declared: b }]).map((side) => (
              <div key={side.tag} className="flex flex-col gap-2 rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <span className="grid size-8 place-items-center rounded-md bg-foreground font-bold text-background">{side.tag}</span>
                  <span className="truncate text-[19px] font-semibold">{side.declared}</span>
                </div>
                {side.decision ? (
                  <>
                    <div className="flex items-center gap-2 text-[18px]">
                      Jev → <ActionTag action={side.decision.action} className="text-[18px]" />
                      {side.decision.confidence !== undefined && <span className="font-mono tabular-nums">conf {Number(side.decision.confidence).toFixed(2)}</span>}
                    </div>
                    {side.probabilities && (
                      <div className="space-y-1">
                        {Object.entries(side.probabilities)
                          .filter(([k]) => k !== "damaged")
                          .map(([k, v]) => (
                            <div key={k} className="flex items-center gap-2 text-[16px]">
                              <span className="w-[80px] font-mono">{k}</span>
                              <div className="h-3 flex-1 rounded-full bg-muted">
                                <div className="h-full rounded-full bg-jev" style={{ width: `${v * 100}%` }} />
                              </div>
                              <span className="w-[44px] text-right font-mono tabular-nums">{v.toFixed(2)}</span>
                            </div>
                          ))}
                      </div>
                    )}
                    {side.call_id && (
                      <button className="self-start font-mono text-[15px] text-muted-foreground underline" onClick={() => onInspect(side.call_id!)}>
                        inspect {side.call_id}
                      </button>
                    )}
                  </>
                ) : (
                  <span className="text-[17px] text-muted-foreground">press Run both</span>
                )}
              </div>
            ))}
            {res && (
              <p className="col-span-2 text-[18px]">
                {res.different ? "Different words, different decision." : "Same decision for both."} A fixed-class detector sees the same pixels and gives the same boxes for both.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Policy editor ────────────────────────────────────────────────────────

export function PolicyEditor({ api, open, onOpenChange, onApplied }: { api: BeltApi; open: boolean; onOpenChange: (o: boolean) => void; onApplied: (p: Policy) => void }) {
  const [policy, setPolicy] = React.useState<Policy | null>(null);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [msg, setMsg] = React.useState<string>("");
  React.useEffect(() => {
    if (!open) return;
    api
      .getPolicy()
      .then((p) => {
        setPolicy(p);
        setDraft({ ...p.options });
        setMsg("");
      })
      .catch((e: Error) => setMsg(e.message));
  }, [api, open]);
  const apply = async (body: { options?: Record<string, string>; preset?: string }) => {
    try {
      const p = await api.setPolicy(body);
      setPolicy(p);
      setDraft({ ...p.options });
      onApplied(p);
      setMsg(`Applied as v${p.version ?? "?"}. The next Jev call uses it.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1100px] gap-4 bg-card p-7 sm:max-w-[1100px]">
        <DialogHeader>
          <DialogTitle className="text-[26px]">
            Policy <span className="font-mono text-[20px] text-muted-foreground">v{policy?.version ?? "–"} · {policy?.name ?? ""}</span>
          </DialogTitle>
          <DialogDescription className="text-[18px]">The words Jev chooses between. Edit, Apply, and the next call uses them: no training images, no retraining.</DialogDescription>
        </DialogHeader>
        {policy?.presets && (
          <div className="flex flex-wrap gap-2">
            {Object.entries(policy.presets).map(([k, v]) => (
              <Button key={k} variant="outline" className="h-10 text-[16px]" onClick={() => apply({ preset: k })}>
                {v.name}
              </Button>
            ))}
          </div>
        )}
        <div className="max-h-[560px] space-y-3 overflow-auto pr-1">
          {Object.entries(draft).map(([k, v]) => (
            <label key={k} className="block">
              <span className={cn("font-mono text-[17px] font-semibold", policy?.options[k] !== v && "text-gemini-ink")}>{k}</span>
              <Textarea className="mt-1 min-h-[64px] font-mono text-[16px] leading-snug md:text-[16px]" value={v} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button size="lg" className="h-12 text-[18px]" onClick={() => apply({ options: draft })} disabled={!policy}>
            Apply
          </Button>
          <span className="text-[17px] text-muted-foreground">{msg}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── End of shift ─────────────────────────────────────────────────────────

// Mode 3 end-of-shift numbers. Jev's decision latency sits next to Gemini's 2nd-look (decision) latency;
// clerk / report / teacher calls are counted on their own, never averaged into a decision number.
const CARD_KEYS: [string, string, "n" | "ms" | "usd"][] = [
  ["parcels", "parcels", "n"],
  ["correct", "correct", "n"],
  ["safe", "safe (held)", "n"],
  ["wrong", "wrong", "n"],
  ["near_miss", "near-miss ships", "n"],
  ["claims_filed", "claims filed", "n"],
  ["blocked_tools", "tool calls blocked", "n"],
  ["gemini_skipped", "Gemini skipped", "n"],
  ["jev_ms_avg", "Jev decision, avg", "ms"],
  ["gemini_decision_ms_avg", "Gemini 2nd look (decision), avg", "ms"],
  ["gemini_decision_calls", "Gemini decision calls", "n"],
  ["gemini_work_calls", "Gemini clerk / report / teacher calls", "n"],
  ["jev_cost", "Jev cost", "usd"],
  ["gemini_decision_cost", "Gemini decision cost", "usd"],
  ["gemini_work_cost", "Gemini work cost", "usd"],
  ["replays", "replayed calls", "n"],
];

export function Scorecard({ s, onClose, open, calib = false }: { s: State; onClose: () => void; open?: boolean; calib?: boolean }) {
  const end = open === false ? undefined : s.runEnd;
  if (s.mode === "h2h") {
    const b = s.h2h.board;
    return (
      <Dialog open={!!end} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-[860px] gap-4 bg-card p-7 sm:max-w-[860px]">
          <DialogHeader>
            <DialogTitle className="text-[30px]">
              <span className="text-jev-ink">Jev</span> vs <span className="text-gemini-ink">Gemini</span>{b?.gemma && <> vs <span className="text-gemma-ink">Gemma 4</span></>}: final scoreboard
            </DialogTitle>
            <DialogDescription className="text-[18px]">
              {b?.parcels ?? 0} parcels · same photo, same question, same moment · graded against the answer key · Esc closes
            </DialogDescription>
          </DialogHeader>
          <H2HScoreboard board={b} big calib={calib} />
        </DialogContent>
      </Dialog>
    );
  }
  const report = end?.report;
  const head = typeof report === "object" && report ? String((report as { headline?: string }).headline ?? "End of shift") : "End of shift";
  const r = report as { report?: string; body?: string } | null;
  const body = typeof report === "string" ? report : r && typeof r === "object" ? String(r.report ?? r.body ?? "") : "No shift report in this mode.";
  return (
    <Dialog open={!!end} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[1000px] gap-5 bg-card p-8 sm:max-w-[1000px]">
        <DialogHeader>
          <DialogTitle className="text-[30px]">{head}</DialogTitle>
          <DialogDescription className="text-[18px]">Scorecard from the server · report written by shift_lead (Gemini)</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-4 gap-3">
          {CARD_KEYS.filter(([k]) => typeof end?.scorecard?.[k] === "number").map(([k, label, kind]) => {
            const v = end!.scorecard[k] as number;
            return (
              <div key={k} className="rounded-lg border p-3">
                <div className="text-[15px] text-muted-foreground">{label}</div>
                <div className="truncate text-[26px] font-semibold tabular-nums">{kind === "ms" ? fmtMs(v) : kind === "usd" ? fmtUsd(v) : v}</div>
              </div>
            );
          })}
        </div>
        <div className="rounded-lg border border-gemini/30 bg-gemini-soft/50 p-4">
          <div className="mb-1 flex items-center gap-2 text-[17px] font-semibold text-gemini-ink">
            <RoleDot role="gemini" /> shift_lead
          </div>
          <p className="text-[20px] leading-relaxed">{body}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
