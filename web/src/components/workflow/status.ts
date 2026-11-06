/**
 * Workflow builder — status & type visual system (SINGLE SOURCE OF TRUTH).
 * ---------------------------------------------------------------------------
 * Every workflow feature reads its colors, glyphs, and motion from here so the
 * language stays identical across Node / Canvas / Subway / TaskBoard / etc.
 * NEVER hardcode a status color in a feature — map through `NODE_STATUS`.
 *
 * Color roles (all OKLCH design tokens, theme-aware):
 *   pending   → muted (calm, no motion)
 *   running   → primary, the one reserved active accent (soft pulse)
 *   completed → success green
 *   failed    → destructive / error red
 *   waiting   → warning / amber, HITL gate (slow pulse)  ← amber's ONLY owner
 *   skipped   → muted, dashed & dimmed
 *
 * `--warning` (amber) is now reserved EXCLUSIVELY for the `waiting` status. It
 * used to double as the low-confidence signal, so a waiting node and a
 * low-confidence node in the same view both glowed amber and the hue meant two
 * different things. CONFIDENCE is therefore a HUE-FREE TEXTURE now (see the
 * `CONFIDENCE` token below): high = a solid neutral mark, low = a neutral
 * diagonal hatch + dashed border + hollow dot. No confidence path touches
 * `--warning`.
 *
 * Surfaces reuse the shipped `status-badge` token pairs (e.g.
 * `bg-success-muted text-success-foreground`) so pill contrast passes AA in
 * both themes; strong `foreground`/`ring`/`dot` fields are for graphical marks
 * (icons, status rings, dots) where the 3:1 non-text bar applies.
 */
import {
  Circle,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Hand,
  SkipForward,
  Sparkles,
  Wrench,
  Split,
  GitMerge,
  UserCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { CSSProperties } from 'react'
import type { NodeStatus, NodeType, Confidence } from './types'

/** How a node signals its state through motion. Motion signals state, never decorates. */
export type MotionHint = 'none' | 'pulse' | 'pulse-slow' | 'spin'

export interface NodeStatusToken {
  /** Human label, e.g. "Running". */
  label: string
  /** Lucide glyph for the status. */
  icon: LucideIcon
  /** Motion signal for this state. */
  motion: MotionHint
  /** Whether the status glyph itself spins (running). */
  spin: boolean
  /**
   * Canonical pill classes — border + tinted surface + accessible foreground.
   * The brief's `tokenClassName`; used for the status badge on every feature.
   */
  tokenClassName: string
  /** Strong accent for graphical marks (icon tint, corner ticks). */
  foreground: string
  /** Faint body tint to emphasise an active/attention node. '' = plain card. */
  surface: string
  /** Ring color for canvas status rings + emphasis outlines. */
  ring: string
  /** Solid status-dot background (compact rows, subway). */
  dot: string
}

/**
 * NodeStatus → visual system. This map is the contract every feature obeys.
 */
export const NODE_STATUS: Record<NodeStatus, NodeStatusToken> = {
  pending: {
    label: 'Pending',
    icon: Circle,
    motion: 'none',
    spin: false,
    tokenClassName: 'border-border bg-muted text-muted-foreground',
    foreground: 'text-muted-foreground',
    surface: '',
    ring: 'ring-border',
    dot: 'bg-muted-foreground/40',
  },
  running: {
    label: 'Running',
    icon: Loader2,
    motion: 'pulse',
    spin: true,
    // Neutral label for contrast; the accent lives in the icon + ring + pulse.
    tokenClassName: 'border-primary/40 bg-primary/10 text-foreground',
    foreground: 'text-primary',
    surface: 'bg-primary/[0.04]',
    ring: 'ring-primary/60',
    dot: 'bg-primary',
  },
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    motion: 'none',
    spin: false,
    tokenClassName: 'border-success/25 bg-success-muted text-success-foreground',
    foreground: 'text-success',
    surface: '',
    ring: 'ring-success/50',
    dot: 'bg-success',
  },
  failed: {
    label: 'Failed',
    icon: AlertTriangle,
    motion: 'none',
    spin: false,
    tokenClassName: 'border-error/25 bg-error-muted text-error-foreground',
    foreground: 'text-destructive',
    surface: 'bg-destructive/[0.04]',
    ring: 'ring-destructive/50',
    dot: 'bg-destructive',
  },
  waiting: {
    label: 'Waiting',
    icon: Hand,
    motion: 'pulse-slow',
    spin: false,
    tokenClassName: 'border-warning/30 bg-warning-muted text-warning-foreground',
    foreground: 'text-warning',
    surface: 'bg-warning/[0.05]',
    ring: 'ring-warning/60',
    dot: 'bg-warning',
  },
  skipped: {
    label: 'Skipped',
    icon: SkipForward,
    motion: 'none',
    spin: false,
    tokenClassName: 'border-dashed border-border bg-transparent text-muted-foreground',
    foreground: 'text-muted-foreground/60',
    surface: '',
    ring: 'ring-border',
    dot: 'bg-muted-foreground/40',
  },
}

export interface NodeTypeToken {
  label: string
  icon: LucideIcon
}

/**
 * NodeType → glyph + label. Neutral-toned (types describe *what*, status
 * describes *state*); the glyph chip stays muted so status owns the color.
 */
export const NODE_TYPE: Record<NodeType, NodeTypeToken> = {
  llm_agent: { label: 'LLM Agent', icon: Sparkles },
  tool: { label: 'Tool', icon: Wrench },
  parallel_fanout: { label: 'Parallel', icon: Split },
  join: { label: 'Join', icon: GitMerge },
  hitl_gate: { label: 'Human Gate', icon: UserCheck },
  sub_workflow: { label: 'Sub-workflow', icon: Workflow },
}

/** MotionHint → animation classes (all reduced-motion safe). */
export const MOTION_CLASS: Record<MotionHint, string> = {
  none: '',
  pulse: 'animate-pulse [animation-duration:1.8s] motion-reduce:animate-none',
  'pulse-slow': 'animate-pulse [animation-duration:2.8s] motion-reduce:animate-none',
  spin: 'animate-spin motion-reduce:animate-none',
}

/**
 * Confidence → the node's outer CONTAINER border. Deliberately NEUTRAL.
 * ---------------------------------------------------------------------------
 * ONE OWNER PER EDGE. Confidence is signalled entirely by the top `ConfidenceEdge`
 * (TOP edge) and status by the left `AccentBar` (LEFT edge). The container border
 * therefore stays a plain `--border` hairline in EVERY state so no corner ever
 * stacks three treatments (it used to: left accent + dashed frame + top edge
 * collided at the top-left of a running, low-confidence node). The frame is gone;
 * the hairline is a non-signal that frees the edges for their single owners.
 * Kept as a function (not an inlined class) so the container stays the single
 * source of the outer border and callers never double-declare `border`.
 */
export function confidenceBorderClass(confidence?: 'high' | 'low'): string {
  // `confidence` is intentionally not read: the container border is a fixed
  // neutral hairline in every state (confidence is carried by ConfidenceEdge).
  // The parameter is retained so callers keep passing `data.confidence` and the
  // signature stays stable if a container-level treatment is reintroduced.
  void confidence
  return 'border border-border'
}

/**
 * Confidence → a HUE-FREE TEXTURE system (SINGLE SOURCE OF TRUTH).
 * ---------------------------------------------------------------------------
 * Confidence is NOT a color. Amber (`--warning`) belongs to `waiting` alone now,
 * so the two
 * confidence states separate by TEXTURE on a neutral base instead of by hue:
 *
 *   • HIGH → a SOLID neutral mark: a filled `--foreground` dot, a solid neutral
 *            top edge, a solid-border chip. A positive "measured, proceed"
 *            signal — high confidence is a *presence*, never an absence.
 *   • LOW  → a diagonal HATCH on a neutral base (`--muted-foreground` stripes) +
 *            a neutral DASHED border + a HOLLOW neutral dot: "pause & verify".
 *
 * Every workflow surface (Node / Canvas / Timeline / …) reads these class tokens
 * and the one `CONFIDENCE_HATCH` so the texture stays byte-identical everywhere
 * and no feature re-hardcodes a confidence color. Token-driven, so it resolves
 * in light and dark with no hex.
 */
export interface ConfidenceToken {
  /** Human label — unchanged copy, only the mark's color/texture is neutralised. */
  label: string
  /** Chip: border + tinted surface + accessible text. Low = dashed neutral. */
  chipClassName: string
  /** The chip/detail dot: high = filled neutral, low = hollow neutral ring. */
  dotClassName: string
  /** The node's TOP edge. High = solid neutral bar; low = neutral hatch (see hatch). */
  edgeClassName: string
  /** Dense-row swatch (≈8–10px) where a hatch can't survive: filled vs hollow. */
  swatchClassName: string
  /** Faint body wash for an at-a-glance low-confidence node — NEUTRAL, not amber. */
  washClassName: string
  /** True when the mark is carried by the diagonal `CONFIDENCE_HATCH` texture. */
  hatch: boolean
}

/**
 * The one low-confidence hatch: coarse `--muted-foreground` diagonal stripes
 * (≈2px stripe on a 6px pitch) so it reads as an intentional neutral caution
 * TEXTURE — not moiré, not amber. Kept at low opacity by the consuming element
 * so it whispers "verify" without shouting a hue.
 */
export const CONFIDENCE_HATCH: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, var(--muted-foreground) 0, var(--muted-foreground) 2px, transparent 2px, transparent 6px)',
}

export const CONFIDENCE: Record<Confidence, ConfidenceToken> = {
  high: {
    label: 'High confidence',
    // Solid-border chip, filled neutral dot — a firm "measured" presence.
    chipClassName: 'border-border bg-muted/60 text-foreground/80',
    dotClassName: 'border border-foreground/25 bg-foreground/70',
    edgeClassName: 'bg-foreground/55',
    swatchClassName: 'border border-foreground/25 bg-foreground/70',
    washClassName: '',
    hatch: false,
  },
  low: {
    label: 'Low confidence',
    // Dashed neutral chip + hollow neutral dot — "pause & verify", zero amber.
    // Text lifted to `--foreground/80` and the dashed border to
    // `--muted-foreground/70` so the pill clears AA on a muted/panel base in both
    // themes while staying strictly hue-free (no amber).
    chipClassName: 'border-dashed border-muted-foreground/70 bg-muted/40 text-foreground/80',
    dotClassName: 'border-[1.5px] border-muted-foreground bg-transparent',
    edgeClassName: '', // carried by CONFIDENCE_HATCH, not a flat fill
    swatchClassName: 'border-[1.5px] border-dashed border-muted-foreground bg-transparent',
    washClassName: 'bg-muted-foreground/[0.05]',
    hatch: true,
  },
}

/** Format wall-clock into the run-view "Worked for" idiom: 720ms · 8.4s · 2m 8s. */
export function formatWorkedFor(ms?: number): string {
  if (ms === undefined || ms === null) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`
}
