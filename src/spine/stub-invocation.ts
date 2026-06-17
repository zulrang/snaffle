import type { AgentResult } from "../domain/agent";
import type { InvocationId } from "../domain/ids";
import type { WriteScope } from "../domain/scope";
import type { Result } from "../domain/shared";
import { err, ok } from "../domain/shared";
import { type AgentResultValidationError, validateAgentResult } from "../lib/validate-agent-result";
import {
  invokeStubAgent,
  type StubInvocationError,
  type StubInvocationMetadata,
  stubResultToAgentResult,
} from "../pi/invoke-stub-agent";

/**
 * W4 — spine stub-agent invocation with validated structured results (D14).
 *
 * The spine drives a stub Pi agent for a single scoped edit, validates the
 * returned artifact, and only then exposes it as evidence for the control plane.
 * Malformed results are rejected and never acted on.
 */

export interface StubEditTask {
  readonly invocationId: InvocationId;
  readonly prompt: string;
  readonly targetPath: string;
  readonly content: string;
}

export interface StubInvocationOptions {
  readonly scope?: WriteScope;
}

export interface ValidatedStubInvocationOutcome {
  readonly agentResult: AgentResult;
  readonly metadata: StubInvocationMetadata;
}

export type ValidatedStubInvocationError = StubInvocationError | AgentResultValidationError;

/**
 * Invoke the stub agent for one edit and validate the structured result before
 * returning it to the control plane.
 */
export const invokeValidatedStubAgent = async (
  task: StubEditTask,
  options: StubInvocationOptions = {},
): Promise<Result<ValidatedStubInvocationOutcome, ValidatedStubInvocationError>> => {
  const invocation = await invokeStubAgent(
    {
      invocationId: task.invocationId,
      prompt: task.prompt,
      targetPath: task.targetPath,
      content: task.content,
    },
    options.scope === undefined ? {} : { scope: options.scope },
  );

  if (!invocation.ok) return err(invocation.error);

  const validated = validateAgentResult(
    stubResultToAgentResult(invocation.value),
    task.invocationId,
  );
  if (!validated.ok) return err(validated.error);

  return ok({
    agentResult: validated.value,
    metadata: invocation.value.metadata,
  });
};
