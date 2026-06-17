import type { GrantId, InvocationId, LineageId } from "../domain/ids";
import type { CapabilityGrant, WriteScope } from "../domain/scope";
import { err, ok, parseTimestamp, type Result } from "../domain/shared";

/**
 * Per-invocation capability grant issuance (D6, W3).
 *
 * Authority is issued by the orchestrator before an agent run. The grant's
 * scope is the sole source of write permission — it is never derived from
 * agent context, prompts, or tool arguments.
 */

export interface IssueCapabilityGrantInput {
  readonly grantId: GrantId;
  readonly lineageId: LineageId;
  readonly invocationId: InvocationId;
  readonly scope: WriteScope;
  readonly issuedAt?: number;
}

export const issueCapabilityGrant = (
  input: IssueCapabilityGrantInput,
): Result<CapabilityGrant, { readonly kind: "invalid_timestamp"; readonly value: number }> => {
  const issuedAtResult =
    input.issuedAt === undefined ? parseTimestamp(Date.now()) : parseTimestamp(input.issuedAt);

  if (!issuedAtResult.ok) return err(issuedAtResult.error);

  return ok({
    grantId: input.grantId,
    lineageId: input.lineageId,
    invocationId: input.invocationId,
    scope: input.scope,
    issuedAt: issuedAtResult.value,
  });
};

/** Reject a grant/task mismatch before invoking an agent (D6). */
export const grantMatchesInvocation = (
  grant: CapabilityGrant,
  invocationId: InvocationId,
): boolean => grant.invocationId === invocationId;
