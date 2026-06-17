import type {
  AgentKind,
  AgentOutcome,
  AgentResult,
  EditOperation,
  FileEdit,
} from "../domain/agent";
import { InvocationId, type InvocationId as InvocationIdType } from "../domain/ids";
import { parseRepoPath } from "../domain/scope";
import { err, ok, type Result } from "../domain/shared";

/**
 * Agent result validation (D14, D19, W4).
 *
 * Results are evidence only. Before the control plane acts on a result, the
 * spine validates its artifact. A malformed packet is never trusted — same guard
 * pattern as failure verdicts (D4).
 */

export type AgentResultValidationError = {
  readonly kind: "malformed";
  readonly reason: string;
};

const AGENT_KINDS: readonly AgentKind[] = [
  "spec",
  "planner",
  "spiker",
  "implementer",
  "test_author",
  "stub",
];

const AGENT_OUTCOMES: readonly AgentOutcome[] = ["succeeded", "refused", "failed"];

const EDIT_OPERATIONS: readonly EditOperation[] = ["create", "modify", "delete"];

interface RawAgentResultFields {
  readonly invocationId: unknown;
  readonly agentKind: unknown;
  readonly outcome: unknown;
  readonly edits: unknown;
  readonly summary: unknown;
}

interface RawEditFields {
  readonly path: unknown;
  readonly operation: unknown;
}

interface RawAgentResultObject {
  readonly invocationId?: unknown;
  readonly agentKind?: unknown;
  readonly outcome?: unknown;
  readonly edits?: unknown;
  readonly summary?: unknown;
}

interface RawEditObject {
  readonly path?: unknown;
  readonly operation?: unknown;
}

const isRecord = (value: unknown): value is RawAgentResultObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readAgentResultFields = (raw: RawAgentResultObject): RawAgentResultFields => ({
  invocationId: raw.invocationId,
  agentKind: raw.agentKind,
  outcome: raw.outcome,
  edits: raw.edits,
  summary: raw.summary,
});

const readEditFields = (raw: RawEditObject): RawEditFields => ({
  path: raw.path,
  operation: raw.operation,
});

const malformed = (reason: string): AgentResultValidationError => ({
  kind: "malformed",
  reason,
});

const parseEdits = (raw: unknown): Result<readonly FileEdit[], AgentResultValidationError> => {
  if (!Array.isArray(raw)) {
    return err(malformed("edits must be an array"));
  }

  const edits: FileEdit[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      return err(malformed("each edit must be an object"));
    }
    const edit = readEditFields(item as RawEditObject);
    if (typeof edit.path !== "string") {
      return err(malformed("edit.path must be a string"));
    }
    if (typeof edit.operation !== "string") {
      return err(malformed("edit.operation must be a string"));
    }
    if (!(EDIT_OPERATIONS as readonly string[]).includes(edit.operation)) {
      return err(malformed(`invalid edit.operation: ${edit.operation}`));
    }

    const path = parseRepoPath(edit.path);
    if (!path.ok) {
      return err(malformed(`invalid edit.path: ${edit.path}`));
    }

    edits.push({
      path: path.value,
      operation: edit.operation as EditOperation,
    });
  }

  return ok(edits);
};

const checkOutcomeConsistency = (
  outcome: AgentOutcome,
  edits: readonly FileEdit[],
): AgentResultValidationError | undefined => {
  if (outcome === "failed" && edits.length > 0) {
    return malformed("failed outcome must not carry edits");
  }
  if (outcome === "refused" && edits.length > 0) {
    return malformed("refused outcome must not carry edits");
  }
  if (outcome === "succeeded" && edits.length === 0) {
    return malformed("succeeded outcome must include at least one edit");
  }
  return undefined;
};

/**
 * Validate an untrusted agent result before the control plane acts on it.
 * Returns the typed domain result or a malformed error — never both.
 */
export const validateAgentResult = (
  raw: unknown,
  expectedInvocationId?: InvocationIdType,
): Result<AgentResult, AgentResultValidationError> => {
  if (!isRecord(raw)) {
    return err(malformed("agent result must be an object"));
  }

  const fields = readAgentResultFields(raw);

  if (typeof fields.invocationId !== "string") {
    return err(malformed("invocationId must be a string"));
  }
  const invocationId = InvocationId(fields.invocationId);
  if (!invocationId.ok) {
    return err(malformed("invocationId must be non-empty"));
  }
  if (expectedInvocationId !== undefined && invocationId.value !== expectedInvocationId) {
    return err(
      malformed(
        `invocationId mismatch: expected ${expectedInvocationId}, got ${invocationId.value}`,
      ),
    );
  }

  if (typeof fields.agentKind !== "string") {
    return err(malformed("agentKind must be a string"));
  }
  if (!(AGENT_KINDS as readonly string[]).includes(fields.agentKind)) {
    return err(malformed(`invalid agentKind: ${fields.agentKind}`));
  }

  if (typeof fields.outcome !== "string") {
    return err(malformed("outcome must be a string"));
  }
  if (!(AGENT_OUTCOMES as readonly string[]).includes(fields.outcome)) {
    return err(malformed(`invalid outcome: ${fields.outcome}`));
  }

  const edits = parseEdits(fields.edits);
  if (!edits.ok) return edits;

  const consistency = checkOutcomeConsistency(fields.outcome as AgentOutcome, edits.value);
  if (consistency) return err(consistency);

  if (typeof fields.summary !== "string" || fields.summary.trim().length === 0) {
    return err(malformed("summary must be a non-empty string"));
  }

  return ok({
    invocationId: invocationId.value,
    agentKind: fields.agentKind as AgentKind,
    outcome: fields.outcome as AgentOutcome,
    edits: edits.value,
    summary: fields.summary,
  });
};

/** True when a result is well-formed and safe for control-plane inspection. */
export const isValidAgentResult = (
  raw: unknown,
  expectedInvocationId?: InvocationIdType,
): raw is AgentResult => validateAgentResult(raw, expectedInvocationId).ok;
