import type { AgentResult } from "../domain/agent";
import type { GenerationId, InvocationId, LineageId } from "../domain/ids";
import { type GenerationRecord, makeGenerationRecord } from "../domain/provenance";
import type { WriteScope } from "../domain/scope";
import { err, ok, parseTimestamp, type Result, type Timestamp } from "../domain/shared";
import {
  buildGenerationInputs,
  computeGenerationContentHash,
  type StubGenerationAgentResult,
  stubGenerationContextFromTask,
} from "../lib/provenance-hash";
import type {
  ProvenanceStore,
  ProvenanceStoreError,
  StoredGenerationMaterial,
} from "../lib/provenance-store";
import type { StubInvocationMetadata } from "../pi/invoke-stub-agent";

/**
 * W7 — spine wiring for content-addressed provenance logging (D10).
 *
 * After a stub invocation, the orchestrator logs one generation record to SQLite
 * with enough material to recompute and verify stored hashes on read-back.
 */

export interface LogStubGenerationInput {
  readonly generationId: GenerationId;
  readonly lineageId: LineageId;
  readonly invocationId: InvocationId;
  readonly prompt: string;
  readonly writes: readonly { readonly path: string; readonly content: string }[];
  readonly metadata: StubInvocationMetadata;
  readonly scope?: WriteScope;
  readonly agentResult?: AgentResult;
  readonly recordedAt?: Timestamp;
}

export type LogStubGenerationError = ProvenanceStoreError | { readonly kind: "invalid_record" };

const agentResultForContext = (result: AgentResult): StubGenerationAgentResult => ({
  outcome: result.outcome,
  summary: result.summary,
  edits: result.edits.map((edit) => ({ path: edit.path, operation: edit.operation })),
});

const buildContext = (input: LogStubGenerationInput) =>
  stubGenerationContextFromTask({
    writes: input.writes,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.agentResult === undefined
      ? {}
      : { agentResult: agentResultForContext(input.agentResult) }),
  });

export const buildStubGenerationRecord = (
  input: LogStubGenerationInput,
): Result<GenerationRecord, { readonly kind: "invalid_record" }> => {
  const context = buildContext(input);
  const inputs = buildGenerationInputs({
    metadata: input.metadata,
    prompt: input.prompt,
    context,
  });
  const contentHash = computeGenerationContentHash(inputs);
  const recordedAt =
    input.recordedAt === undefined ? parseTimestamp(Date.now()) : parseTimestamp(input.recordedAt);

  if (!recordedAt.ok) return err({ kind: "invalid_record" });

  const built = makeGenerationRecord({
    generationId: input.generationId,
    lineageId: input.lineageId,
    invocationId: input.invocationId,
    inputs,
    contentHash,
    recordedAt: recordedAt.value,
  });
  if (!built.ok) return err({ kind: "invalid_record" });

  return ok(built.value);
};

/** Log one stub generation to the provenance store. */
export const logStubGeneration = (
  store: ProvenanceStore,
  input: LogStubGenerationInput,
): Result<GenerationRecord, LogStubGenerationError> => {
  const record = buildStubGenerationRecord(input);
  if (!record.ok) return err(record.error);

  const material: StoredGenerationMaterial = {
    prompt: input.prompt,
    context: buildContext(input),
  };

  const inserted = store.insert(record.value, material);
  if (!inserted.ok) return err(inserted.error);

  return ok(record.value);
};
