import type { InvocationId } from "./ids";
import { pathWithinScope, type RepoPath, type WriteScope } from "./scope";

/**
 * Agents and their results (D3, D14, D19).
 *
 * An agent is invoked with scoped context in and returns a structured result
 * out. That result is *evidence only*: it never mutates authoritative state and
 * never carries authority. The control plane validates it, checks it against the
 * granted scope, and derives any state transition itself (D19).
 */

/**
 * The agents that exist because stochasticity is irreducible there (D3). `stub`
 * is the Phase-1 stand-in used to prove the SDK invocation contract before real
 * agents exist. There is deliberately no validator or commit agent.
 */
export type AgentKind = "spec" | "planner" | "spiker" | "implementer" | "test_author" | "stub";

export type EditOperation = "create" | "modify" | "delete";

export interface FileEdit {
  readonly path: RepoPath;
  readonly operation: EditOperation;
}

/**
 * What the agent reports it did. This is the agent's *claim*, not a verdict — the
 * deterministic gate decides pass/fail, and the control plane decides the
 * transition. `refused` records a legitimate decline (e.g. the agent's own
 * permission gate denied an out-of-scope write).
 */
export type AgentOutcome = "succeeded" | "refused" | "failed";

export interface AgentResult {
  readonly invocationId: InvocationId;
  readonly agentKind: AgentKind;
  readonly outcome: AgentOutcome;
  readonly edits: readonly FileEdit[];
  readonly summary: string;
}

/**
 * Paths the result tried to edit that fall outside the granted scope (D6). An
 * empty array means the result is scope-compliant; a non-empty array is a
 * scope violation the control plane must hard-reject (D4).
 */
export const scopeViolations = (result: AgentResult, scope: WriteScope): readonly RepoPath[] =>
  result.edits.map((edit) => edit.path).filter((path) => !pathWithinScope(scope, path));

export const isScopeCompliant = (result: AgentResult, scope: WriteScope): boolean =>
  scopeViolations(result, scope).length === 0;
