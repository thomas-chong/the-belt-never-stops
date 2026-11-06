// ADK workflow graph. Node visuals follow the workflow-node language (status glyph + label,
// left accent bar, motion only for live state) using the shared NODE_STATUS / NODE_TYPE tokens.
import * as React from "react";
import { cn } from "@/lib/utils";
import { NODE_STATUS, NODE_TYPE, MOTION_CLASS } from "@/components/workflow/status";
import type { NodeStatus, NodeType } from "@/components/workflow/types";
import { Panel, ROLE, type Role } from "@/components/bits";
import type { State } from "@/state";

const W = 644;
const H = 252;
const NW = 140;
const NH = 42;
const CX = [0, 168, 336, 504];
const RY = [0, 70, 140, 210];

interface GNode {
  id: string;
  label: string;
  x: number;
  y: number;
  role: Role;
  type: NodeType;
  aliases?: string[];
}

// Mirrors the server's Workflow: enter -> tick -> gate -> {check_claim (loop), desk* (second look),
// read_label -> claims_clerk [before_tool gate] -> claim_ready, summarise -> shift_lead -> finish}.
// The human desk and the teacher sit beside the graph (a queue and an offline agent).
const NODES: GNode[] = [
  { id: "check_claim", label: "check_claim", x: CX[0], y: RY[0], role: "adk", type: "tool" },
  { id: "tick", label: "tick (Jev)", x: CX[0], y: RY[1], role: "jev", type: "tool", aliases: ["jev", "reflex"] },
  { id: "summarise", label: "summarise", x: CX[0], y: RY[2], role: "adk", type: "tool", aliases: ["summarize", "summarise_plain"] },
  { id: "gate", label: "gate", x: CX[1], y: RY[1], role: "adk", type: "join", aliases: ["route", "router"] },
  { id: "shift_lead", label: "shift lead", x: CX[1], y: RY[2], role: "gemini", type: "llm_agent", aliases: ["finish"] },
  { id: "read_label", label: "read_label", x: CX[2], y: RY[0], role: "adk", type: "tool" },
  { id: "second_look", label: "2nd look", x: CX[2], y: RY[1], role: "gemini", type: "llm_agent" },
  { id: "human_desk", label: "human desk", x: CX[2], y: RY[2], role: "human", type: "hitl_gate", aliases: ["human", "desk"] },
  { id: "teacher", label: "teacher", x: CX[2], y: RY[3], role: "gemini", type: "llm_agent", aliases: ["teach"] },
  { id: "claims_clerk", label: "claims clerk", x: CX[3], y: RY[0], role: "gemini", type: "llm_agent" },
  { id: "tool_gate", label: "tool gate", x: CX[3], y: RY[1], role: "adk", type: "hitl_gate", aliases: ["guard", "guardrail", "before_tool"] },
  { id: "claim_ready", label: "claim_ready", x: CX[3], y: RY[2], role: "adk", type: "tool", aliases: ["rest"] },
];

const IGNORE = new Set(["START", "start", "enter", "END", "end"]);

type EdgeKind = "auto" | "elbow" | "corner" | "loop";
const EDGES: [string, string, string?, EdgeKind?][] = [
  ["tick", "gate"],
  ["gate", "check_claim", undefined, "elbow"],
  ["check_claim", "tick"],
  ["gate", "read_label"],
  ["gate", "second_look"],
  ["gate", "human_desk"],
  ["second_look", "human_desk"],
  ["human_desk", "teacher"],
  ["read_label", "claims_clerk"],
  ["claims_clerk", "tool_gate"],
  ["tool_gate", "claim_ready"],
  ["gate", "summarise", undefined, "corner"],
  ["summarise", "shift_lead"],
  ["teacher", "tick", "policy", "loop"],
];

const ALIAS = new Map<string, string>();
for (const n of NODES) {
  ALIAS.set(n.id, n.id);
  for (const a of n.aliases ?? []) ALIAS.set(a, n.id);
}

function phaseToStatus(phase?: string): NodeStatus {
  switch (phase) {
    case "start":
    case "running":
      return "running";
    case "end":
    case "done":
      return "completed";
    case "skip":
    case "skipped":
      return "skipped";
    case "wait":
    case "waiting":
      return "waiting";
    case "error":
    case "blocked":
      return "failed";
    default:
      return "pending";
  }
}

function edgePath(a: GNode, b: GNode, kind: EdgeKind = "auto"): string {
  const acx = a.x + NW / 2,
    acy = a.y + NH / 2,
    bcx = b.x + NW / 2,
    bcy = b.y + NH / 2;
  if (kind === "elbow") return `M${acx},${a.y} C${acx},${bcy} ${acx},${bcy} ${b.x + NW},${bcy}`;
  if (kind === "corner") return `M${a.x + 14},${a.y + NH} C${a.x + 14},${b.y + 10} ${a.x},${b.y + 10} ${b.x + NW},${b.y + 10}`;
  if (kind === "loop") return `M${a.x},${acy} C${-22},${acy} ${-22},${bcy + 8} ${b.x},${bcy + 8}`;
  if (Math.abs(acy - bcy) < 2) {
    const [x1, x2] = bcx > acx ? [a.x + NW, b.x] : [a.x, b.x + NW];
    return `M${x1},${acy} L${x2},${bcy}`;
  }
  if (Math.abs(acx - bcx) < 2) {
    const [y1, y2] = bcy > acy ? [a.y + NH, b.y] : [a.y, b.y + NH];
    return `M${acx},${y1} L${bcx},${y2}`;
  }
  const x1 = a.x + NW;
  const x2 = b.x;
  return `M${x1},${acy} C${(x1 + x2) / 2},${acy} ${(x1 + x2) / 2},${bcy} ${x2},${bcy}`;
}

/** caption-bar node names (server `step` events) -> graph node ids */
const CAPTION_NODE: Record<string, string> = {
  tick: "tick",
  gate: "gate",
  auto: "gate",
  "human desk": "human_desk",
  "2nd look": "second_look",
  read_label: "read_label",
  "tool gate": "tool_gate",
};

/** The caption bar (A6): the latest graph step in plain words, always on in mode 3. */
export function CaptionBar({ s }: { s: State }) {
  const c = s.caption;
  return (
    <div data-testid="caption-bar" className={cn("flex min-h-[40px] items-center gap-2 rounded-md border px-3 py-1 text-[22px] leading-tight", c?.walk ? "border-adk bg-adk-soft" : "bg-muted/50")}>
      {c ? (
        <>
          <span className="shrink-0 font-mono text-[18px] font-semibold text-muted-foreground">{c.parcel_id}</span>
          <span className="line-clamp-2 min-w-0" title={c.text}>
            {c.text}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">Each step of each parcel shows here in plain words.</span>
      )}
    </div>
  );
}

export function AdkGraph({ s, title = "ADK workflow" }: { s: State; title?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.7);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setScale(Math.min(r.width / (W + 24), r.height / H));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const status: Record<string, { st: NodeStatus; count: number; ts: number }> = {};
  const extra: { node: string; st: NodeStatus }[] = [];
  for (const [node, ns] of Object.entries(s.adk)) {
    if (IGNORE.has(node)) continue;
    const id = ALIAS.get(node) ?? (/^(second_look_)?desk_?\d*$/.test(node) ? "second_look" : /^teach_/.test(node) ? "teacher" : undefined);
    const st = phaseToStatus(ns.phase);
    if (!id) {
      extra.push({ node, st });
      continue;
    }
    const prev = status[id];
    if (!prev || ns.ts >= prev.ts) status[id] = { st, count: (prev?.count ?? 0) + ns.count, ts: ns.ts };
  }
  const lastTool = s.toolOrder.length ? s.tools[s.toolOrder[s.toolOrder.length - 1]] : undefined;
  if (lastTool && !status.tool_gate) {
    const v = lastTool.verdict;
    status.tool_gate = { st: !v ? "running" : v.allowed ? "completed" : "failed", count: s.toolOrder.length, ts: v?.ts ?? lastTool.proposed.ts };
  }
  if (!status.human_desk && (s.humanQueue.length || Object.values(s.parcels).some((p) => p.humanAction))) {
    status.human_desk = { st: s.humanQueue.length ? "waiting" : "completed", count: 0, ts: 0 };
  }
  const byId = new Map(NODES.map((n) => [n.id, n]));
  const now = Date.now() / 1000;
  // the node the caption bar talks about is drawn larger, with a thick ring, while it is active
  const [, tickle] = React.useState(0);
  const cap = s.caption;
  const capAge = cap ? Date.now() / 1000 - cap.ts : Infinity;
  const hold = cap ? Math.max(cap.walk ? cap.pause_s + 0.3 : 0, 1.6) : 0;
  const activeNode = cap && capAge < hold ? CAPTION_NODE[cap.node] : undefined;
  React.useEffect(() => {
    if (!cap) return;
    const t = setTimeout(() => tickle((x) => x + 1), Math.max(50, (hold - capAge) * 1000 + 50));
    return () => clearTimeout(t);
  }, [cap, hold, capAge]);

  return (
    <Panel title={title} role="adk" aside={<span>floor manager · lights up from adk_node events</span>} className="shrink-0" bodyClassName="flex flex-col gap-1.5 px-3 pb-2 pt-2">
      <div ref={ref} className="relative h-[256px] w-full">
        <div className="absolute left-1/2 top-0 origin-top" style={{ width: W, height: H, transform: `translateX(calc(-50% + 10px)) scale(${scale})` }}>
          <svg width={W} height={H} className="absolute inset-0 overflow-visible">
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)" />
              </marker>
            </defs>
            {EDGES.map(([a, b, label, kind]) => {
              const A = byId.get(a)!;
              const B = byId.get(b)!;
              const hot = status[a]?.st === "completed" && (status[b]?.st === "running" || status[b]?.st === "waiting") && now - (status[b]?.ts ?? 0) < 3;
              const d = edgePath(A, B, kind);
              const dash = kind === "loop";
              return (
                <g key={a + b}>
                  <path d={d} fill="none" stroke={hot ? "var(--foreground)" : "var(--border)"} strokeWidth={hot ? 3 : 2} strokeDasharray={dash ? "6 5" : undefined} markerEnd="url(#arr)" />
                  {label && (
                    <text
                      x={dash ? (A.x + B.x + NW) / 2 - 30 : (A.x + NW + B.x) / 2}
                      y={dash ? A.y + NH / 2 - 6 : (A.y + B.y) / 2 + NH / 2 - 6}
                      textAnchor="middle"
                      className="fill-muted-foreground"
                      style={{ fontSize: 15, fontWeight: 600 }}
                    >
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {NODES.map((n) => {
            const st = status[n.id]?.st ?? "pending";
            const tok = NODE_STATUS[st];
            const Icon = tok.icon;
            const fresh = now - (status[n.id]?.ts ?? 0) < 0.8;
            const active = activeNode === n.id;
            return (
              <div
                key={n.id}
                className={cn(
                  "absolute flex items-center gap-2 overflow-hidden rounded-lg border bg-card pl-3 pr-2 shadow-xs transition-[box-shadow,transform] duration-200",
                  active && "z-10 scale-[1.18] shadow-lg ring-[6px]",
                  st === "running" && "ring-[3px]",
                  st === "waiting" && "ring-[3px] ring-human",
                  st === "failed" && "ring-[3px] ring-error",
                  st === "skipped" && "border-dashed opacity-60",
                  st === "pending" && "opacity-70",
                  fresh && "flash",
                )}
                style={{
                  left: n.x,
                  top: n.y,
                  width: NW,
                  height: NH,
                  ["--tw-ring-color" as string]: active || st === "running" ? `var(--${n.role})` : undefined,
                }}
                title={`${n.id} · ${tok.label}`}
              >
                <span className={cn("absolute inset-y-0 left-0 w-1.5", ROLE[n.role].bar)} />
                <span className="truncate text-[15.5px] font-semibold" title={NODE_TYPE[n.type].label}>{n.label}</span>
                <Icon
                  className={cn(
                    "ml-auto size-4 shrink-0",
                    st === "completed" ? "text-success" : st === "failed" ? "text-error" : st === "waiting" ? "text-human" : "text-muted-foreground",
                    tok.spin && MOTION_CLASS.spin,
                  )}
                />
              </div>
            );
          })}
        </div>
      </div>
      <CaptionBar s={s} />
      {extra.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-[14px]">
          {extra.slice(-6).map((x) => (
            <span key={x.node} className={cn("rounded border px-1.5 font-mono", NODE_STATUS[x.st].tokenClassName)}>
              {x.node} · {NODE_STATUS[x.st].label}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}
