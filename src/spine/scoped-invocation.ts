import type { AgentResult } from "../domain/agent";
import type { InvocationId } from "../domain/ids";
import type { CapabilityGrant, RepoPath } from "../domain/scope";
import { parseRepoPath } from "../domain/scope";
import type { Result } from "../domain/shared";
import { err, ok } from "../domain/shared";
import { grantMatchesInvocation } from "../lib/capability-grant";
import {
  invokeStubAgentSequence,
  type StubInvocationError,
  type StubInvocationMetadata,
  stubResultToAgentResult,
} from "../pi/invoke-stub-agent";

/**
 * W3 — spine wiring for capability grant + path protection (D6).
 *
 * The orchestrator issues a grant, invokes the agent with the grant's scope
 * wired through pi-agent-core's beforeToolCall guard, and collects every
 * in-scope success and out-of-scope denial for control-plane inspection.
 * Scope never comes from agent-visible context.
 */

export type ScopeEvent =
  | {
      readonly kind: "write_allowed";
      readonly toolName: string;
      readonly path: RepoPath;
    }
  | {
      readonly kind: "write_denied";
      readonly toolName: string;
      readonly path: string;
      readonly reason: string;
    };

export interface ScopedWriteAttempt {
  readonly path: string;
  readonly content: string;
}

export interface ScopedInvocationTask {
  readonly invocationId: InvocationId;
  readonly prompt: string;
  readonly writes: readonly ScopedWriteAttempt[];
}

export interface ScopedInvocationOutcome {
  readonly grant: CapabilityGrant;
  readonly agentResult: AgentResult;
  readonly scopeEvents: readonly ScopeEvent[];
  readonly metadata: StubInvocationMetadata;
}

export type ScopedInvocationError =
  | StubInvocationError
  | {
      readonly kind: "grant_invocation_mismatch";
      readonly grantId: string;
      readonly invocationId: string;
    };

/**
 * Invoke a stub agent under a spine-issued capability grant. Write scope is
 * taken exclusively from `grant.scope` and enforced via lib/scope-guard.
 */
export const invokeWithCapabilityGrant = async (
  grant: CapabilityGrant,
  task: ScopedInvocationTask,
): Promise<Result<ScopedInvocationOutcome, ScopedInvocationError>> => {
  if (!grantMatchesInvocation(grant, task.invocationId)) {
    return err({
      kind: "grant_invocation_mismatch",
      grantId: grant.grantId,
      invocationId: task.invocationId,
    });
  }

  const scopeEvents: ScopeEvent[] = [];

  const result = await invokeStubAgentSequence(
    {
      invocationId: task.invocationId,
      prompt: task.prompt,
      writes: task.writes,
    },
    {
      scope: grant.scope,
      onScopeDenial: (denial, toolName) => {
        scopeEvents.push({
          kind: "write_denied",
          toolName,
          path: denial.path,
          reason: denial.reason,
        });
      },
      onWriteAllowed: (path, toolName) => {
        scopeEvents.push({
          kind: "write_allowed",
          toolName,
          path,
        });
      },
    },
  );

  if (!result.ok) return err(result.error);

  return ok({
    grant,
    agentResult: stubResultToAgentResult(result.value),
    scopeEvents,
    metadata: result.value.metadata,
  });
};

/** Parse and validate write paths before invoking the agent. */
export const validateScopedWrites = (
  writes: readonly ScopedWriteAttempt[],
): Result<
  readonly ScopedWriteAttempt[],
  { readonly kind: "invalid_target_path"; readonly detail: string }
> => {
  for (const write of writes) {
    const parsed = parseRepoPath(write.path);
    if (!parsed.ok) {
      return err({ kind: "invalid_target_path", detail: write.path });
    }
  }
  return ok(writes);
};
