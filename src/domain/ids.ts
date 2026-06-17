import type { Brand } from "./shared";
import { idConstructor } from "./shared";

/**
 * Central registry of branded identifiers.
 *
 * Keeping every aggregate's id type in one module lets aggregates reference each
 * other's ids without importing each other, avoiding circular dependencies. Each
 * name binds both a *type* (the branded string) and a *value* (its validating
 * constructor) via TypeScript declaration merging.
 */

/** A lineage: one spec requirement and its frozen acceptance target (D20). */
export type LineageId = Brand<string, "LineageId">;
export const LineageId = idConstructor("LineageId");

/** The spec requirement a lineage exists to satisfy. */
export type RequirementId = Brand<string, "RequirementId">;
export const RequirementId = idConstructor("RequirementId");

/** A single attempt (initial or remediation) within a lineage. */
export type AttemptId = Brand<string, "AttemptId">;
export const AttemptId = idConstructor("AttemptId");

/** A per-invocation capability grant issued by the orchestrator (D6). */
export type GrantId = Brand<string, "GrantId">;
export const GrantId = idConstructor("GrantId");

/** One agent invocation that produced a result (D14/D19). */
export type InvocationId = Brand<string, "InvocationId">;
export const InvocationId = idConstructor("InvocationId");

/** One deterministic gate execution (D8). */
export type GateRunId = Brand<string, "GateRunId">;
export const GateRunId = idConstructor("GateRunId");

/** One control-plane-derived state transition (D19). */
export type TransitionId = Brand<string, "TransitionId">;
export const TransitionId = idConstructor("TransitionId");

/** One logged model generation in the provenance store (D10). */
export type GenerationId = Brand<string, "GenerationId">;
export const GenerationId = idConstructor("GenerationId");

/** An isolated worktree a lineage executes in (D20/D23). */
export type WorktreeId = Brand<string, "WorktreeId">;
export const WorktreeId = idConstructor("WorktreeId");

/** One batched human decision item in the HITL queue (D11). */
export type DecisionId = Brand<string, "DecisionId">;
export const DecisionId = idConstructor("DecisionId");

/** A batch of related human decisions surfaced together (D11). */
export type BatchId = Brand<string, "BatchId">;
export const BatchId = idConstructor("BatchId");
