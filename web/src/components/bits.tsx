import * as React from "react";
import { cn } from "@/lib/utils";
import type { Lane } from "@/types";

export type Role = "jev" | "gemini" | "gemma" | "adk" | "human";

export const ROLE: Record<Role, { name: string; dot: string; text: string; soft: string; border: string; bar: string }> = {
  jev: { name: "Jev", dot: "bg-jev", text: "text-jev-ink", soft: "bg-jev-soft", border: "border-jev/40", bar: "bg-jev" },
  gemini: { name: "Gemini", dot: "bg-gemini", text: "text-gemini-ink", soft: "bg-gemini-soft", border: "border-gemini/40", bar: "bg-gemini" },
  gemma: { name: "Gemma", dot: "bg-gemma", text: "text-gemma-ink", soft: "bg-gemma-soft", border: "border-gemma/40", bar: "bg-gemma" },
  adk: { name: "ADK", dot: "bg-adk", text: "text-adk-ink", soft: "bg-adk-soft", border: "border-adk/40", bar: "bg-adk" },
  human: { name: "Human", dot: "bg-human", text: "text-human-ink", soft: "bg-human-soft", border: "border-human/50", bar: "bg-human" },
};

export const LANE: Record<Lane, { title: string; who: string; role: Role }> = {
  auto: { title: "Auto", who: "Jev alone", role: "jev" },
  gemini: { title: "Second look", who: "Gemini", role: "gemini" },
  human: { title: "Human desk", who: "a person", role: "human" },
};

export function RoleDot({ role, className }: { role: Role; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-3 shrink-0 rounded-full", ROLE[role].dot, className)} />;
}

export function Panel({
  title,
  role,
  aside,
  className,
  bodyClassName,
  children,
}: {
  title: React.ReactNode;
  role?: Role;
  aside?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex min-h-0 flex-col rounded-xl border bg-card shadow-xs", className)}>
      <header className="flex h-[44px] shrink-0 items-center gap-3 border-b px-4">
        {role && <RoleDot role={role} />}
        <h2 className="whitespace-nowrap text-[20px] font-semibold tracking-tight">{title}</h2>
        <div className="ml-auto flex min-w-0 items-center gap-2 truncate text-[16px] text-muted-foreground">{aside}</div>
      </header>
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

/** LIVE / REPLAY, straight from the server's `live` flag on that call. */
export function LiveBadge({ live, className }: { live: boolean | undefined; className?: string }) {
  if (live === undefined) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[14px] font-semibold tracking-wide",
        live ? "border-success/40 bg-success-muted text-success-foreground" : "border-border bg-muted text-muted-foreground",
        className,
      )}
      title={live ? "the server made this call live" : "the server replayed a recorded answer for this call"}
    >
      <span className={cn("size-2 rounded-full", live ? "bg-success" : "bg-muted-foreground/60")} />
      {live ? "LIVE" : "REPLAY"}
    </span>
  );
}

export function ActionTag({ action, className }: { action?: string; className?: string }) {
  if (!action) return null;
  return (
    <span className={cn("rounded-md bg-foreground px-2 py-0.5 font-mono text-[15px] font-semibold uppercase tracking-wide text-background", className)}>
      {action.replace("_", " ")}
    </span>
  );
}

export function Metric({ label, value, sub, role, className }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; role?: Role; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <span className="flex items-center gap-1.5 text-[15px] font-medium text-muted-foreground">
        {role && <RoleDot role={role} className="size-2.5" />}
        {label}
      </span>
      <span className={cn("font-semibold tabular-nums leading-tight text-[26px]", role && ROLE[role].text)}>{value}</span>
      {sub && <span className="text-[15px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

export function Json({ value, className }: { value: unknown; className?: string }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className={cn("overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/70 p-3 font-mono text-[16px] leading-relaxed", className)}>
      {text}
    </pre>
  );
}
