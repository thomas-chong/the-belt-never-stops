/**
 * Workflow builder — shared domain types.
 * ---------------------------------------------------------------------------
 * The FOUNDATION every workflow feature (Node, Canvas, Inspector, Subway,
 * TaskBoard, …) imports. Keep this the single vocabulary for node kind,
 * lifecycle status, and confidence so the visual language never drifts.
 *
 * Design thesis (shadcn "harness"): the DAG *is* the intent specification —
 * make intent first-class and legible, make output rendered not narrated.
 * These types describe a node's intent + telemetry; `status.ts` maps them to
 * a single source-of-truth visual system.
 */

/** The kind of work a node performs. Drives the type glyph + label. */
export type NodeType =
  | 'llm_agent'
  | 'tool'
  | 'parallel_fanout'
  | 'join'
  | 'hitl_gate'
  | 'sub_workflow'

/** A node's lifecycle state. Drives color role, glyph, and motion. */
export type NodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting' // human-in-the-loop gate awaiting a person
  | 'skipped'

/**
 * Per-node/output confidence. `high` → solid border (proceed);
 * `low` → hatched/dashed border (pause & verify). Purely a signal — never
 * the only affordance (a "Low confidence" chip accompanies it).
 */
export type Confidence = 'high' | 'low'

/**
 * The data contract a node renders from. Telemetry fields are optional so a
 * `pending` node (no runtime yet) and a `completed` node (full receipts) use
 * the same shape.
 */
export interface WorkflowNodeData {
  id: string
  title: string
  type: NodeType
  status: NodeStatus
  /** Solid vs hatched border signal. Omit when not yet assessed. */
  confidence?: Confidence
  /** Number of sub-tasks the node owns (EditableTaskList count). */
  taskCount?: number
  /** Inputs consumed — the "Sources" half of provenance. */
  sourcesCount?: number
  /** Artifacts produced — the "Outputs" half of provenance. */
  outputsCount?: number
  /** Named input files — the receipt behind `sourcesCount` (shown on demand). */
  sourceNames?: string[]
  /** Named output artifacts — the receipt behind `outputsCount` (teal class). */
  outputNames?: string[]
  /** Wall-clock the node has worked for, in milliseconds. */
  durationMs?: number
  /** One-line intent/telemetry summary, revealed on demand. */
  summary?: string
}
