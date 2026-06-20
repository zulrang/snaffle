import type { AgentResult } from "../domain/agent";
import type { InvocationId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { err, ok, type Result } from "../domain/shared";
import { AGENT_DEFINITIONS } from "../lib/agents";
import {
  buildOracleFreezeRecord,
  type OracleFreezeRecord,
  saveOracleFreezeRecord,
} from "../lib/oracle-freeze";
import type { OrchestratorConfig } from "../lib/orchestrator-config";
import { applyWritesToWorktree } from "../lib/worktree-writes";
import type { CapturedWrite } from "../pi/invoke-stub-agent";
import type { PromptCacheHint } from "../pi/prompt-cache";
import { type AgentInvocationError, invokeAgent } from "./invoke-agent";
import type { ScopedWriteAttempt, ScopeEvent } from "./scoped-invocation";

/**
 * Oracle-authoring phase (W4, D7). The test-author authors the acceptance oracle
 * inside its frozen-test scope; the spine then applies it and freezes + hashes it
 * *before* any implementer runs. The frozen record is handed to the implementer
 * read-only, and its hash is recorded in provenance — the gradee never authors,
 * weakens, or even sees a mutable copy of its own grader.
 */

export const ORACLE_FREEZE_REL_PATH = ".orchestrator/oracle-freeze.json";

export interface OracleAuthoringInput {
  readonly worktreeRoot: string;
  readonly invocationId: InvocationId;
  /** Declared frozen-test paths that constitute the oracle. */
  readonly oraclePaths: readonly string[];
  /** Spine-supplied content for the authored oracle (paths only come from the agent). */
  readonly oracleWrites: readonly ScopedWriteAttempt[];
  readonly config: OrchestratorConfig;
  readonly repoRoot: string;
  readonly frozenAt: number;
  readonly prompt?: string;
  readonly cacheHint?: PromptCacheHint;
}

export interface OracleAuthoringOutcome {
  readonly agentResult: AgentResult;
  readonly freeze: OracleFreezeRecord;
  readonly scopeEvents: readonly ScopeEvent[];
  readonly writes: readonly CapturedWrite[];
}

export type OracleAuthoringError =
  | { readonly kind: "scope_invalid"; readonly detail: string }
  | { readonly kind: "authoring_refused"; readonly outcome: string }
  | { readonly kind: "apply_failed"; readonly detail: string }
  | { readonly kind: "freeze_failed"; readonly path: string }
  | AgentInvocationError;

export const runOracleAuthoringPhase = async (
  input: OracleAuthoringInput,
): Promise<Result<OracleAuthoringOutcome, OracleAuthoringError>> => {
  const paths = [];
  for (const raw of input.oraclePaths) {
    const parsed = parseRepoPath(raw);
    if (!parsed.ok) return err({ kind: "scope_invalid", detail: raw });
    paths.push(parsed.value);
  }
  const scope = makeWriteScope(paths);
  if (!scope.ok) return err({ kind: "scope_invalid", detail: JSON.stringify(scope.error) });

  const authored = await invokeAgent({
    definition: AGENT_DEFINITIONS.test_author,
    invocationId: input.invocationId,
    prompt: input.prompt ?? "Author the frozen acceptance oracle.",
    writes: input.oracleWrites,
    scope: scope.value,
    config: input.config,
    repoRoot: input.repoRoot,
    workspaceRoot: input.worktreeRoot,
    ...(input.cacheHint === undefined ? {} : { cacheHint: input.cacheHint }),
  });
  if (!authored.ok) return err(authored.error);
  if (authored.value.agentResult.outcome !== "succeeded") {
    return err({ kind: "authoring_refused", outcome: authored.value.agentResult.outcome });
  }

  // The agent supplies paths; the spine applies content into the isolated worktree (W8).
  const applied = applyWritesToWorktree(
    input.worktreeRoot,
    authored.value.writes.map((write) => ({ path: write.path, content: write.content })),
  );
  if (!applied.ok) return err({ kind: "apply_failed", detail: JSON.stringify(applied.error) });

  // Freeze + hash BEFORE any implementer is invoked.
  const freeze = buildOracleFreezeRecord(input.worktreeRoot, input.oraclePaths, input.frozenAt);
  if (!freeze.ok) return err({ kind: "freeze_failed", path: freeze.error.path });

  const saved = saveOracleFreezeRecord(input.worktreeRoot, ORACLE_FREEZE_REL_PATH, freeze.value);
  if (!saved.ok) return err({ kind: "freeze_failed", path: ORACLE_FREEZE_REL_PATH });

  return ok({
    agentResult: authored.value.agentResult,
    freeze: freeze.value,
    scopeEvents: authored.value.scopeEvents,
    writes: authored.value.writes,
  });
};
