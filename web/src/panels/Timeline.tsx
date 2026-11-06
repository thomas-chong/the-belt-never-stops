import * as React from "react";
import { RoleDot } from "@/components/bits";
import { jobOf, JOB_LABEL, type State } from "@/state";

const WINDOW_S = 40;

function useNow(ms = 200) {
  const [now, setNow] = React.useState(() => Date.now() / 1000);
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Timeline({ s, onInspect }: { s: State; onInspect: (id: string) => void }) {
  const now = useNow();
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(1200);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const LABEL = 150;
  const plotW = Math.max(100, w - LABEL - 8);
  const t0 = now - WINDOW_S;
  const x = (t: number) => LABEL + ((t - t0) / WINDOW_S) * plotW;
  const ROW_J = 4;
  const ROW_G = 42;
  const RH = 32;
  const calls = s.callOrder.map((id) => s.calls[id]).filter((c) => c && (c.end ?? now) >= t0);
  const jev = calls.filter((c) => c.kind === "jev");
  const gem = calls.filter((c) => c.kind === "llm");
  const decisions = gem.filter((c) => jobOf(c) === "decision").length;
  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border bg-card px-4 py-1.5 shadow-xs">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[20px] font-semibold">Two speeds, one run</h2>
        <span className="text-[17px] text-muted-foreground">Jev decides every parcel (~0.1 s); Gemini bars are coloured by job · last {WINDOW_S} s · click to inspect</span>
        <span className="ml-auto flex items-center gap-3 text-[16px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <RoleDot role="jev" className="size-2.5" /> {jev.length} Jev decisions
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-full" style={{ background: "var(--job-decision)" }} /> {decisions} Gemini decision calls
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-full" style={{ background: "var(--job-clerk)" }} /> {gem.length - decisions} clerk/report/teacher calls
          </span>
        </span>
      </div>
      <div ref={ref} className="relative min-h-0 flex-1">
        <svg width={w} height={90} className="block">
          <text x={0} y={ROW_J + 22} style={{ fontSize: 18, fontWeight: 600 }} className="fill-jev-ink">
            Jev
          </text>
          <text x={0} y={ROW_G + 22} style={{ fontSize: 18, fontWeight: 600 }} className="fill-gemini-ink">
            Gemini
          </text>
          <rect x={LABEL} y={ROW_J} width={plotW} height={RH} rx={6} className="fill-jev-soft" />
          <rect x={LABEL} y={ROW_G} width={plotW} height={RH} rx={6} className="fill-gemini-soft" />
          {[0, 10, 20, 30].map((ago) => (
            <g key={ago}>
              <line x1={x(now - ago)} x2={x(now - ago)} y1={ROW_J - 4} y2={ROW_G + RH + 2} stroke="var(--border)" />
              <text x={x(now - ago) - 4} y={ROW_G + RH + 13} textAnchor="end" style={{ fontSize: 13 }} className="fill-muted-foreground">
                {ago === 0 ? "now" : `−${ago}s`}
              </text>
            </g>
          ))}
          {jev.map((c) => (
            <rect
              key={c.call_id}
              x={x(c.start)}
              y={ROW_J + 4}
              width={Math.max(4, x(c.end ?? now) - x(c.start))}
              height={RH - 8}
              rx={2}
              className="cursor-pointer fill-jev hover:fill-jev-ink"
              onClick={() => onInspect(c.call_id)}
            >
              <title>{`${c.call_id} · Jev ${Math.round(c.ms ?? 0)} ms · ${c.parcel_id ?? ""}`}</title>
            </rect>
          ))}
          {gem.map((c) => {
            const x1 = Math.max(LABEL, x(c.start));
            const x2 = x(c.end ?? now);
            const wide = x2 - x1;
            const job = jobOf(c);
            const short = job === "decision" ? "2nd look" : job;
            return (
              <g key={c.call_id} className="cursor-pointer" onClick={() => onInspect(c.call_id)}>
                <rect x={x1} y={ROW_G + 4} width={Math.max(4, wide)} height={RH - 8} rx={5} style={{ fill: `var(--job-${job})`, opacity: c.end === undefined ? 0.6 : 1 }} stroke="white" strokeWidth={1} />
                {wide > 70 && (
                  <text x={x1 + 8} y={ROW_G + 21} style={{ fontSize: 15, fontWeight: 600 }} className="pointer-events-none fill-white">
                    {short}
                  </text>
                )}
                <title>{`${c.call_id} · ${JOB_LABEL[job]} · ${c.agent} · ${c.ms ? Math.round(c.ms) + " ms" : "in flight"}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
