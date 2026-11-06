import * as React from "react";
import { ArrowRight, ShieldCheck, ShieldX, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LiveBadge, Panel } from "@/components/bits";
import { fmtMs, fmtUsd, jobOf, JOB_LABEL, type State } from "@/state";


export function GeminiStream({ s, onInspect, collapsed = false, title = "Gemini" }: { s: State; onInspect: (id: string) => void; collapsed?: boolean; title?: string }) {
  const llm = s.callOrder.filter((id) => s.calls[id]?.kind === "llm");
  const id = s.activeLlm ?? llm[llm.length - 1];
  const c = id ? s.calls[id] : undefined;
  const streaming = c && c.end === undefined;
  const recent = llm.slice(-4, -1).reverse().filter((x) => x !== id);
  return (
    <Panel
      title={title}
      role="gemini"
      aside={<span>{collapsed ? (streaming ? "streaming…" : `${llm.length} calls`) : "every call labelled by its job"}</span>}
      className={collapsed ? "shrink-0" : "h-[262px] shrink-0"}
      bodyClassName={collapsed ? "hidden" : "flex flex-col gap-2 p-3"}
    >
      {!c ? (
        <p className="text-[18px] text-muted-foreground">No Gemini call yet. Jev decides every parcel; Gemini is asked only for a second look, a claim, the teacher and the shift report.</p>
      ) : (
        <>
          <button className="flex min-w-0 items-center gap-2 whitespace-nowrap text-left" onClick={() => onInspect(c.call_id)} title="open in the Inspector">
            <span className="rounded-md px-2 py-0.5 text-[16px] font-semibold text-white" style={{ background: `var(--job-${jobOf(c)})` }}>
              {JOB_LABEL[jobOf(c)]}
            </span>
            <span className="truncate font-mono text-[16px] text-muted-foreground">
              {c.agent}
              {c.parcel_id ? ` · ${c.parcel_id}` : ""}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {streaming ? (
                <span className="flex items-center gap-1.5 text-[16px] text-gemini-ink">
                  <Loader2 className="size-4 animate-spin" /> streaming
                </span>
              ) : (
                <span className="font-mono text-[16px] tabular-nums text-muted-foreground">
                  {fmtMs(c.ms)} · {fmtUsd(c.cost)}
                </span>
              )}
              <LiveBadge live={c.live} />
            </span>
          </button>
          <div className={cn("min-h-0 flex-1 overflow-auto rounded-lg border border-gemini/25 bg-gemini-soft/50 p-3 font-mono text-[18px] leading-relaxed whitespace-pre-wrap break-words", streaming && "caret")}>
            {c.thought && !c.text && <span className="italic text-muted-foreground">{c.thought.slice(-600)}</span>}
            {c.text || (streaming ? "" : JSON.stringify(c.output, null, 2))}
          </div>
          {recent.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {recent.map((rid) => {
                const r = s.calls[rid];
                return (
                  <button key={rid} onClick={() => onInspect(rid)} className="flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[15px] hover:bg-muted">
                    <span className="inline-block size-2.5 rounded-full" style={{ background: `var(--job-${jobOf(r)})` }} />
                    <span className="font-mono">{jobOf(r) === "decision" ? "2nd look" : jobOf(r)}</span>
                    <span className="text-muted-foreground">{fmtMs(r.ms)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function kv(v: unknown) {
  if (v === null || v === undefined) return "–";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function Guardrail({ s, onInspect }: { s: State; onInspect: (id: string) => void }) {
  const id = s.toolOrder[s.toolOrder.length - 1];
  const t = id ? s.tools[id] : undefined;
  const v = t?.verdict;
  const rawEvidence: Record<string, unknown> = v ? (typeof v.evidence === "string" ? { evidence: v.evidence } : v.evidence ?? {}) : {};
  // Jev's evidence first: that is what the gate checked the proposal against
  const evidence = Object.fromEntries(
    Object.entries(rawEvidence).sort(([a], [b]) => Number(!a.startsWith("jev_")) - Number(!b.startsWith("jev_"))),
  );
  return (
    <Panel
      title="Guardrail"
      role="adk"
      aside={<span>Gemini proposes · code decides</span>}
      className={cn("min-h-0 flex-1 transition-shadow", v && !v.allowed && "ring-2 ring-error/60")}
      bodyClassName="p-3"
    >
      {!t ? (
        <p className="text-[18px] text-muted-foreground">When Gemini proposes a tool call (file_claim, issue_refund), a deterministic gate checks it against Jev&apos;s evidence before it runs.</p>
      ) : (
        <div className="grid h-full grid-cols-[minmax(0,1fr)_28px_minmax(0,1.15fr)] items-stretch gap-1.5">
          <button className="flex min-w-0 flex-col rounded-lg border border-gemini/30 bg-gemini-soft/50 p-3 text-left" onClick={() => onInspect(t.call_id)}>
            <span className="text-[15px] font-medium text-gemini-ink">{t.proposed.agent} proposes</span>
            <span className="truncate font-mono text-[26px] font-bold">{t.proposed.tool}()</span>
            <div className="mt-2 space-y-1 font-mono text-[17px]">
              {Object.entries(t.proposed.args ?? {}).slice(0, 5).map(([k, val]) => (
                <div key={k} className="truncate">
                  <span className="text-muted-foreground">{k}:</span> {kv(val)}
                </div>
              ))}
            </div>
          </button>
          <div className="grid place-items-center">
            <ArrowRight className="size-7 text-adk" />
          </div>
          <div
            className={cn(
              "flex min-w-0 flex-col rounded-lg border-2 p-3",
              !v && "border-dashed border-adk/40 bg-adk-soft",
              v?.allowed && "border-success/60 bg-success-muted",
              v && !v.allowed && "border-error/70 bg-error-muted",
            )}
          >
            <span className="text-[15px] font-medium text-adk-ink">ADK gate, before the tool runs</span>
            {!v ? (
              <span className="flex items-center gap-2 text-[22px] font-bold text-adk-ink">
                <Loader2 className="size-5 animate-spin" /> checking
              </span>
            ) : (
              <>
                <span className={cn("my-1 flex items-center gap-2 text-[32px] font-extrabold leading-tight tracking-wide", v.allowed ? "text-success-foreground" : "text-error-foreground")}>
                  {v.allowed ? <ShieldCheck className="size-7" /> : <ShieldX className="size-7" />}
                  {v.allowed ? "ALLOWED" : "BLOCKED"}
                </span>
                <span className="line-clamp-3 text-[18px] leading-snug [overflow-wrap:anywhere]">{v.rule.replace(/_/g, "_\u200b")}</span>
                <div className="mt-auto flex flex-col font-mono text-[16px]">
                  {Object.entries(evidence).slice(0, 4).map(([k, val]) => (
                    <span key={k}>
                      <span className="text-jev-ink">{k.replace(/^jev_/, "jev.")}</span>={kv(val)}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

const UNREADABLE = /unreadable/i;

/** One field of the claim form: what Gemini wrote, red when UNREADABLE, ✓/✗ when code checked it against the label. */
function Field({ k, v, ok }: { k: string; v?: string; ok?: boolean }) {
  const bad = !v || UNREADABLE.test(v);
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="w-[86px] shrink-0 text-[13px] uppercase tracking-wide text-muted-foreground">{k}</span>
      <span className={cn("min-w-0 truncate font-mono text-[17px] leading-[24px]", bad && "font-bold text-error-foreground")}>{v || "–"}</span>
      {ok !== undefined && (
        <span className={cn("ml-auto shrink-0 text-[17px] font-bold", ok ? "text-success-foreground" : "text-error-foreground")}>{ok ? "✓" : "✗"}</span>
      )}
    </div>
  );
}

/** Mode 3: the damage claim as a paper form. Left the label Gemini read, middle the packet it wrote,
 * right the ADK gate's stamp on the tool it proposed. Chips below pick an earlier claim of the run. */
export function ClaimForm({ s, onInspect }: { s: State; onInspect: (id: string) => void }) {
  const [pick, setPick] = React.useState<string | null>(null);
  const order = s.claimOrder;
  const pid = pick && s.claims[pick] ? pick : order[order.length - 1];
  const c = pid ? s.claims[pid] : undefined;
  const pk = c?.packet?.packet;
  const g = c?.packet?.graded;
  const t = c?.tool;
  const v = t?.verdict;
  const claimId = c?.packet?.claim?.claim_id;
  return (
    <Panel
      title="Claim form"
      role="adk"
      aside={
        order.length > 1 ? (
          <span className="flex gap-1">
            {order.map((id) => {
              const x = s.claims[id];
              const st = x.tool?.verdict ? (x.tool.verdict.allowed ? "ok" : "blocked") : "";
              return (
                <button
                  key={id}
                  onClick={() => setPick(id === order[order.length - 1] ? null : id)}
                  className={cn("rounded border px-1.5 font-mono text-[13px] hover:bg-muted", id === pid && "border-adk bg-adk-soft")}
                >
                  <span className={cn("mr-1 inline-block size-2 rounded-full", st === "ok" ? "bg-success" : st === "blocked" ? "bg-error" : "bg-muted-foreground")} />
                  {id.replace("P-0", "")}
                </button>
              );
            })}
          </span>
        ) : (
          <span>Gemini reads the label · code decides</span>
        )
      }
      className={cn("min-h-0 flex-1 transition-shadow", v && !v.allowed && "ring-2 ring-error/60")}
      bodyClassName="flex min-h-0 flex-col p-2.5"
    >
      {!c ? (
        <p className="text-[18px] text-muted-foreground">
          When Jev sees damage, Gemini reads the shipping label into a claim form and proposes file_claim or issue_refund. A
          deterministic gate checks it against Jev&apos;s evidence before it runs.
        </p>
      ) : (
        <>
          <div className="grid min-h-0 flex-1 grid-cols-[140px_minmax(0,1fr)_178px] gap-2.5">
            <button className="flex min-h-0 flex-col gap-0.5 text-left" onClick={() => t && onInspect(t.call_id)} title="open in the Inspector">
              <img src={c.url} alt={`shipping label of ${c.parcel_id}`} className="min-h-0 w-full flex-1 rounded-md border object-cover object-top" />
              <span className="font-mono text-[14px] text-muted-foreground">
                {c.parcel_id} · scan {c.scan}
              </span>
            </button>
            <div className="flex min-w-0 flex-col">
              {c.reading || !pk ? (
                <span className="flex items-center gap-2 text-[20px] text-gemini-ink">
                  <Loader2 className="size-5 animate-spin" /> {t ? "Gemini is writing the claim form…" : "Gemini is reading the label…"}
                </span>
              ) : (
                <>
                  <Field k="tracking" v={pk.tracking} ok={g?.tracking_ok} />
                  <Field k="ship-to zip" v={pk.consignee_zip} ok={g?.zip_ok} />
                  <Field k="service" v={pk.service} />
                  <Field k="marks" v={(pk.marks ?? []).join(", ")} ok={g?.marks_ok} />
                  <Field k="contents" v={pk.declared_contents} />
                  <p className="mt-0.5 line-clamp-2 border-t pt-0.5 text-[15px] italic leading-tight">“{pk.claim_note || "–"}”</p>
                </>
              )}
            </div>
            <div
              className={cn(
                "flex min-w-0 flex-col rounded-lg border-2 p-2",
                !v && "border-dashed border-adk/40 bg-adk-soft",
                v?.allowed && "border-success/60 bg-success-muted",
                v && !v.allowed && "border-error/70 bg-error-muted",
              )}
            >
              <span className="truncate font-mono text-[16px] font-bold">{t ? `${t.proposed.tool}()` : "no tool yet"}</span>
              {!v ? (
                <span className="mt-1 text-[16px] text-adk-ink">{t ? "gate checking…" : "waiting for a proposal"}</span>
              ) : (
                <>
                  <span className={cn("my-0.5 flex items-center gap-1.5 text-[22px] font-extrabold", v.allowed ? "text-success-foreground" : "text-error-foreground")}>
                    {v.allowed ? <ShieldCheck className="size-6" /> : <ShieldX className="size-6" />}
                    {v.allowed ? "ALLOWED" : "BLOCKED"}
                  </span>
                  <span className="line-clamp-2 text-[13px] leading-tight [overflow-wrap:anywhere]">{v.rule.replace(/_/g, "_​")}</span>
                </>
              )}
              <span className="mt-auto font-mono text-[13px] leading-tight">
                {c.packet?.jev && <>jev.damaged={c.packet.jev.damaged.toFixed(2)}<br /></>}
                {claimId ? <b className="text-success-foreground">{claimId} filed</b> : c.packet && !c.packet.filed ? <span className="text-error-foreground">not filed{c.packet.retry ? " · re-scan" : ""}</span> : null}
              </span>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}
