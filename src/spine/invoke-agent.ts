import type { AgentResult } from "../domain/agent";
import type { InvocationId } from "../domain/ids";
import type { WriteScope } from "../domain/scope";
import { err, ok, type Result } from "../domain/shared";
import { assembleAgentContext } from "../lib/agent-context";
import type { AgentDefinition } from "../lib/agents";
import type { OracleFreezeRecord } from "../lib/oracle-freeze";
import type { ModelRef, OrchestratorConfig } from "../lib/orchestrator-config";
import { loadSkills, type SkillLoadError } from "../lib/skills";
import { resolveModelTier } from "../lib/tier-router";
import {
  type CapturedWrite,
  invokeStubAgentSequence,
  type StubInvocationError,
  type StubInvocationMetadata,
} from "../pi/invoke-stub-agent";
import type { ExplicitSkillRef } from "../pi/isolated-invocation";
import type { PromptCacheHint } from "../pi/prompt-cache";
import type { ScopedWriteAttempt, ScopeEvent } from "./scoped-invocation";

/**
 * Real-agent invocation (W2). Composes an agent definition's skills into the
 * stable prefix (D26), resolves its tier to a provider-neutral model (D18), and
 * drives the agent through the same scoped adapter as the stub. Default tests stay
 * faux-backed; `--live` or `SNAFFLE_LIVE_MODEL=1` switches to the config-resolved live model.
 * The structured result is evidence only; the control plane derives transitions (D19).
 */

export interface AgentInvocationInput {
  readonly definition: AgentDefinition;
  readonly invocationId: InvocationId;
  readonly prompt: string;
  readonly writes: readonly ScopedWriteAttempt[];
  readonly scope: WriteScope;
  readonly config: OrchestratorConfig;
  /** Repo root from which skill markdown is loaded. */
  readonly repoRoot: string;
  /** When set, symlink hops are resolved before scope checks (D6). */
  readonly workspaceRoot?: string;
  /** Frozen oracle handed read-only to the implementer (D7). */
  readonly oracleFreeze?: OracleFreezeRecord;
  /** Provider-neutral prompt-cache hint (D26); carried out-of-band via stream options. */
  readonly cacheHint?: PromptCacheHint;
  /** When true, invoke the config-resolved live model instead of the faux provider. */
  readonly live?: boolean;
}

export interface AgentInvocationOutcome {
  readonly agentResult: AgentResult;
  readonly metadata: StubInvocationMetadata;
  readonly scopeEvents: readonly ScopeEvent[];
  readonly writes: readonly CapturedWrite[];
  readonly modelRef: ModelRef;
  readonly systemPrompt: string;
}

export type AgentInvocationError =
  | { readonly kind: "skill_load"; readonly detail: SkillLoadError }
  | StubInvocationError;

/** `--live` on the CLI or `SNAFFLE_LIVE_MODEL=1` selects the config-resolved provider. */
export const resolveInvocationLive = (explicitLive?: boolean): boolean =>
  explicitLive === true || process.env["SNAFFLE_LIVE_MODEL"] === "1";

/** Invoke one real agent: compose skills → resolve tier → run scoped. */
export const invokeAgent = async (
  input: AgentInvocationInput,
): Promise<Result<AgentInvocationOutcome, AgentInvocationError>> => {
  const skills = loadSkills(input.definition.skills, input.repoRoot);
  if (!skills.ok) return err({ kind: "skill_load", detail: skills.error });

  const { prefix: systemPrompt, tail } = assembleAgentContext(
    input.definition.kind,
    skills.value,
    input.prompt,
  );
  const explicitSkills: readonly ExplicitSkillRef[] = skills.value.map((skill) => ({
    name: skill.name,
    version: skill.version,
  }));
  const modelRef = resolveModelTier(input.definition.tier, input.config);

  const scopeEvents: ScopeEvent[] = [];
  const result = await invokeStubAgentSequence(
    { invocationId: input.invocationId, prompt: tail, writes: input.writes },
    {
      scope: input.scope,
      systemPrompt,
      modelRef,
      explicitSkills,
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
      ...(input.oracleFreeze === undefined ? {} : { oracleFreeze: input.oracleFreeze }),
      ...(input.cacheHint === undefined ? {} : { promptCache: input.cacheHint }),
      ...(resolveInvocationLive(input.live) ? { invocationMode: "live" as const } : {}),
      onScopeDenial: (denial, toolName) => {
        scopeEvents.push({
          kind: "write_denied",
          toolName,
          path: denial.path,
          reason: denial.reason,
        });
      },
      onWriteAllowed: (path, toolName) => {
        scopeEvents.push({ kind: "write_allowed", toolName, path });
      },
    },
  );
  if (!result.ok) return err(result.error);

  const agentResult: AgentResult = {
    invocationId: input.invocationId,
    agentKind: input.definition.kind,
    outcome: result.value.status,
    edits: result.value.edits,
    summary: result.value.summary,
  };

  return ok({
    agentResult,
    metadata: result.value.metadata,
    scopeEvents,
    writes: result.value.writes,
    modelRef,
    systemPrompt,
  });
};
