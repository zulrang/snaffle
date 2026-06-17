import type { AgentOutcome } from "./agent";
import type { DoorClassification } from "./door";
import type { GateOutcome } from "./gate";
import type { GateRunId, InvocationId, LineageId, TransitionId } from "./ids";
import type { Timestamp } from "./shared";

/**
 * Pipeline phases and control-plane-derived state transitions (D19, §8).
 *
 * Results are evidence; the control plane derives every transition. An agent
 * result — even a successful one — never moves a lineage. The orchestrator
 * inspects the *validated* result and the *authoritative* POST-gate and decides
 * the consequent transition itself. A green check does not move the item; a
 * "succeeded" outcome does not merge anything — only the control plane does.
 */

/** The phases a change is carried through (§8); `spike` is orthogonal/optional. */
export const PIPELINE_PHASES = [
  "spec",
  "plan",
  "spike",
  "implement",
  "validate",
  "commit",
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export type RejectReason =
  | "scope_violation"
  | "oracle_tampering"
  | "agent_failed"
  | "human_rejected";
export type HoldReason = "post_gate_red" | "agent_refused";

/** The lifecycle state of a lineage. Closure is a positive decision (D20). */
export type LineageState =
  | { readonly status: "admitted" }
  | { readonly status: "running"; readonly phase: PipelinePhase }
  | { readonly status: "awaiting_human" }
  | { readonly status: "merged" }
  | { readonly status: "rejected"; readonly reason: RejectReason };

/** What justified a transition, for the audit trail (D10/D19). */
export interface TransitionBasis {
  readonly invocationId?: InvocationId;
  readonly gateRunId?: GateRunId;
}

export interface StateTransition {
  readonly transitionId: TransitionId;
  readonly lineageId: LineageId;
  readonly from: LineageState;
  readonly to: LineageState;
  readonly at: Timestamp;
  readonly basis: TransitionBasis;
}

/**
 * The control plane's decision about a post-apply result. This is the single
 * place the merge consequence is derived; it is intentionally a pure function of
 * declared evidence so it is fully testable without a model in the loop.
 */
export type MergeOutcome =
  /** Two-way door, gate green, in scope: the control plane may merge. */
  | { readonly kind: "merge" }
  /** One-way door, gate green: pause for mandatory human sign-off (D11). */
  | { readonly kind: "await_human" }
  /** Not mergeable yet; no state change (e.g. W6: green result but red POST-gate). */
  | { readonly kind: "hold"; readonly reason: HoldReason }
  /** Terminal failure. */
  | { readonly kind: "reject"; readonly reason: RejectReason };

export interface MergeDecisionInput {
  readonly door: DoorClassification;
  readonly agentOutcome: AgentOutcome;
  readonly postGate: GateOutcome;
  /** Result of the D6 scope check over the result's edits. */
  readonly scopeCompliant: boolean;
}

/**
 * Derive the merge consequence from validated evidence (D19, §8 steps 5–9).
 *
 * Authority ordering:
 * 1. Scope containment (D6) — terminal regardless of gate or agent self-report.
 * 2. Agent `refused` — pre-apply scope enforcement at the agent boundary.
 * 3. POST-gate (D8) — sole acceptance authority; beats agent `succeeded`/`failed`.
 * 4. Door direction — merge (two-way) or await human (one-way) when gate is green.
 *
 * A green gate with a `failed` agent self-report still proceeds: the gate judges
 * applied work, not the agent's claim. A red gate with a `succeeded` self-report
 * holds: the gate blocks regardless of what the agent says it did.
 */
export const deriveMergeOutcome = (input: MergeDecisionInput): MergeOutcome => {
  if (!input.scopeCompliant) {
    return { kind: "reject", reason: "scope_violation" };
  }
  if (input.agentOutcome === "refused") {
    return { kind: "hold", reason: "agent_refused" };
  }
  if (input.postGate === "red") {
    return { kind: "hold", reason: "post_gate_red" };
  }
  return input.door.direction === "one_way" ? { kind: "await_human" } : { kind: "merge" };
};
