// Human-in-the-loop gate parts, adapted from the HITLGate pattern (status pill, pulsing gate
// glyph, left accent bar, one dominant approve action) and sized for a projector.
import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { NODE_STATUS, MOTION_CLASS } from "./status";
import type { NodeStatus } from "./types";

export function StatusPill({ status, label }: { status: NodeStatus; label?: string }) {
  const t = NODE_STATUS[status];
  const Icon = t.icon;
  return (
    <span className={cn("inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[15px] font-medium", t.tokenClassName)}>
      <Icon aria-hidden className={cn("size-4 shrink-0", t.foreground, t.motion !== "none" && MOTION_CLASS[t.motion])} />
      {label ?? t.label}
    </span>
  );
}

export function GateGlyph({ icon: Icon, pulse = true, className }: { icon?: LucideIcon; pulse?: boolean; className?: string }) {
  const Mark = Icon ?? NODE_STATUS.waiting.icon;
  return (
    <span className={cn("relative inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-warning/30 bg-warning-muted text-warning", className)}>
      <Mark aria-hidden className={cn("size-5", pulse && MOTION_CLASS["pulse-slow"])} />
    </span>
  );
}

export function AccentBar({ status, className }: { status: NodeStatus; className?: string }) {
  const t = NODE_STATUS[status];
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-y-0 left-0 w-1 rounded-l-[inherit]", t.dot, t.motion !== "none" && MOTION_CLASS[t.motion === "spin" ? "pulse" : t.motion], className)}
    />
  );
}

export type GateTone = "approve" | "reject" | "neutral";

const GATE_TONE: Record<GateTone, string> = {
  approve: "border-transparent bg-success-foreground text-background font-semibold shadow-sm hover:bg-success-foreground/90",
  reject: "border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10",
  neutral: "border-border bg-card text-foreground hover:bg-accent",
};

export function GateButton({
  tone,
  icon: Icon,
  children,
  className,
  ...props
}: React.ComponentProps<"button"> & { tone: GateTone; icon?: LucideIcon }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-11 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border px-3.5 text-[18px] font-medium outline-none transition-colors active:scale-[0.98]",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100",
        GATE_TONE[tone],
        className,
      )}
      {...props}
    >
      {Icon && <Icon aria-hidden className="size-5" />}
      {children}
    </button>
  );
}

export function MetaRow({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[15px]">
      {items.map((m, i) => (
        <React.Fragment key={m.label}>
          {i > 0 && (
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground">{m.label}</span>
            <span className="font-mono font-medium tabular-nums">{m.value}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
