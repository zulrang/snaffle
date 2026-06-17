import type { GenerationId, InvocationId, LineageId } from "./ids";
import { type ContentHash, err, ok, type Result, type Timestamp } from "./shared";

/**
 * Deterministic provenance (D10, D21).
 *
 * Every model generation is logged content-addressed: the model, the prompt, the
 * context, the temperature/seed, the tool/SDK versions, and — because the control
 * plane's own configuration is part of what produced the output — the hash of the
 * frozen execution plan (D21). The recorded hashes must recompute from the stored
 * inputs (W7), giving a near-free, replayable audit trail.
 */

/** A provider-neutral, pinned model reference (D18: no hardcoded vendor). */
export interface ModelRef {
  readonly provider: string;
  readonly model: string;
  readonly version?: string;
}

/**
 * The canonical inputs a generation's content address is computed over. Stored
 * alongside the record so the hash can be recomputed and verified (W7).
 */
export interface GenerationInputs {
  readonly model: ModelRef;
  readonly promptHash: ContentHash;
  readonly contextHash: ContentHash;
  /** The frozen execution plan that governed this generation (D21). */
  readonly planHash: ContentHash;
  /** Pinned to 0 where the provider allows (D10). */
  readonly temperature: number;
  readonly seed?: number;
  /** Pinned tool/SDK versions, e.g. `pi-agent-core`, `pi-ai`. */
  readonly toolVersions: Readonly<Record<string, string>>;
}

export interface GenerationRecord {
  readonly generationId: GenerationId;
  readonly lineageId: LineageId;
  readonly invocationId: InvocationId;
  readonly inputs: GenerationInputs;
  /** Content address over `inputs`; recomputable for audit (W7). */
  readonly contentHash: ContentHash;
  readonly recordedAt: Timestamp;
}

export type GenerationRecordError =
  | { readonly kind: "invalid_temperature"; readonly value: number }
  | { readonly kind: "empty_model" };

export const makeGenerationRecord = (record: {
  readonly generationId: GenerationId;
  readonly lineageId: LineageId;
  readonly invocationId: InvocationId;
  readonly inputs: GenerationInputs;
  readonly contentHash: ContentHash;
  readonly recordedAt: Timestamp;
}): Result<GenerationRecord, GenerationRecordError> => {
  const { temperature, model } = record.inputs;
  if (!Number.isFinite(temperature) || temperature < 0) {
    return err({ kind: "invalid_temperature", value: temperature });
  }
  if (model.provider.trim().length === 0 || model.model.trim().length === 0) {
    return err({ kind: "empty_model" });
  }
  return ok(record);
};
