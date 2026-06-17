import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GenerationId, InvocationId, LineageId } from "../domain/ids";
import type { GenerationRecord } from "../domain/provenance";
import { makeGenerationRecord } from "../domain/provenance";
import {
  type ContentHash,
  contentHashEquals,
  err,
  ok,
  parseContentHash,
  parseTimestamp,
  type Result,
} from "../domain/shared";
import {
  computeContextHash,
  type StubGenerationContext,
  verifyGenerationInputs,
} from "./provenance-hash";

/**
 * SQLite provenance store (D10, D18, W7).
 *
 * Persists content-addressed generation records with the raw prompt/context
 * material needed to recompute and verify stored hashes on read-back.
 */

export const PROVENANCE_DB_DIR = ".orchestrator";
export const PROVENANCE_DB_FILE = "provenance.sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS generation_records (
  generation_id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT,
  prompt_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  temperature REAL NOT NULL,
  seed INTEGER,
  tool_versions_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  context_payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_invocation
  ON generation_records (invocation_id);
`;

export interface StoredGenerationMaterial {
  readonly prompt: string;
  readonly context: StubGenerationContext;
}

export interface StoredGeneration {
  readonly record: GenerationRecord;
  readonly material: StoredGenerationMaterial;
}

export type ProvenanceStoreError =
  | { readonly kind: "invalid_record"; readonly detail: string }
  | { readonly kind: "duplicate_generation"; readonly generationId: string }
  | { readonly kind: "database_error"; readonly detail: string };

export interface ProvenanceStore {
  readonly dbPath: string;
  insert(
    record: GenerationRecord,
    material: StoredGenerationMaterial,
  ): Result<void, ProvenanceStoreError>;
  getByGenerationId(
    generationId: GenerationId,
  ): Result<StoredGeneration | undefined, ProvenanceStoreError>;
  getByInvocationId(
    invocationId: InvocationId,
  ): Result<StoredGeneration | undefined, ProvenanceStoreError>;
  verifyContextHash(generationId: GenerationId): Result<boolean, ProvenanceStoreError>;
  close(): void;
}

const parseRequiredHash = (value: string): ContentHash | undefined => {
  const parsed = parseContentHash(value);
  return parsed.ok ? parsed.value : undefined;
};

interface GenerationRecordRow {
  readonly generation_id: unknown;
  readonly lineage_id: unknown;
  readonly invocation_id: unknown;
  readonly content_hash: unknown;
  readonly recorded_at: unknown;
  readonly prompt_hash: unknown;
  readonly context_hash: unknown;
  readonly plan_hash: unknown;
  readonly temperature: unknown;
  readonly model_provider: unknown;
  readonly model_name: unknown;
  readonly model_version: unknown;
  readonly seed: unknown;
  readonly tool_versions_json: unknown;
  readonly prompt: unknown;
  readonly context_payload_json: unknown;
}

const parseStoredGeneration = (row: GenerationRecordRow): StoredGeneration | undefined => {
  const generationIdRaw = row.generation_id;
  const lineageIdRaw = row.lineage_id;
  const invocationIdRaw = row.invocation_id;
  const contentHashRaw = row.content_hash;
  const recordedAtRaw = row.recorded_at;
  const promptHashRaw = row.prompt_hash;
  const contextHashRaw = row.context_hash;
  const planHashRaw = row.plan_hash;
  const temperatureRaw = row.temperature;
  const modelProviderRaw = row.model_provider;
  const modelNameRaw = row.model_name;
  const modelVersionRaw = row.model_version;
  const seedRaw = row.seed;
  const toolVersionsJsonRaw = row.tool_versions_json;
  const promptRaw = row.prompt;
  const contextPayloadJsonRaw = row.context_payload_json;

  if (
    typeof generationIdRaw !== "string" ||
    typeof lineageIdRaw !== "string" ||
    typeof invocationIdRaw !== "string" ||
    typeof contentHashRaw !== "string" ||
    typeof recordedAtRaw !== "number" ||
    typeof promptHashRaw !== "string" ||
    typeof contextHashRaw !== "string" ||
    typeof planHashRaw !== "string" ||
    typeof temperatureRaw !== "number" ||
    typeof modelProviderRaw !== "string" ||
    typeof modelNameRaw !== "string" ||
    typeof toolVersionsJsonRaw !== "string" ||
    typeof promptRaw !== "string" ||
    typeof contextPayloadJsonRaw !== "string"
  ) {
    return undefined;
  }

  const generationId = GenerationId(generationIdRaw);
  const lineageId = LineageId(lineageIdRaw);
  const invocationId = InvocationId(invocationIdRaw);
  const contentHash = parseRequiredHash(contentHashRaw);
  const recordedAt = parseTimestamp(recordedAtRaw);
  const promptHash = parseRequiredHash(promptHashRaw);
  const contextHash = parseRequiredHash(contextHashRaw);
  const planHash = parseRequiredHash(planHashRaw);
  const modelVersion = typeof modelVersionRaw === "string" ? modelVersionRaw : undefined;
  const seed = typeof seedRaw === "number" ? seedRaw : undefined;

  if (
    !generationId.ok ||
    !lineageId.ok ||
    !invocationId.ok ||
    !contentHash ||
    !recordedAt.ok ||
    !promptHash ||
    !contextHash ||
    !planHash
  ) {
    return undefined;
  }

  let toolVersions: Readonly<Record<string, string>>;
  try {
    const parsed = JSON.parse(toolVersionsJsonRaw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    toolVersions = Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return undefined;
  }

  let context: StubGenerationContext;
  try {
    const parsed = JSON.parse(contextPayloadJsonRaw) as Partial<StubGenerationContext>;
    if (
      typeof parsed.targetPath !== "string" ||
      typeof parsed.content !== "string" ||
      !Array.isArray(parsed.allowedPaths) ||
      !parsed.allowedPaths.every((path) => typeof path === "string")
    ) {
      return undefined;
    }
    context = {
      targetPath: parsed.targetPath,
      content: parsed.content,
      allowedPaths: [...parsed.allowedPaths],
    };
  } catch {
    return undefined;
  }

  const built = makeGenerationRecord({
    generationId: generationId.value,
    lineageId: lineageId.value,
    invocationId: invocationId.value,
    inputs: {
      model: {
        provider: modelProviderRaw,
        model: modelNameRaw,
        ...(modelVersion === undefined || modelVersion.length === 0
          ? {}
          : { version: modelVersion }),
      },
      promptHash,
      contextHash,
      planHash,
      temperature: temperatureRaw,
      ...(seed === undefined ? {} : { seed }),
      toolVersions,
    },
    contentHash,
    recordedAt: recordedAt.value,
  });

  if (!built.ok) return undefined;

  return {
    record: built.value,
    material: { prompt: promptRaw, context },
  };
};

export const openProvenanceStore = (dbPath: string): ProvenanceStore => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);

  const insert = (
    record: GenerationRecord,
    material: StoredGenerationMaterial,
  ): Result<void, ProvenanceStoreError> => {
    try {
      db.run(
        `INSERT INTO generation_records (
          generation_id, lineage_id, invocation_id, content_hash, recorded_at,
          model_provider, model_name, model_version,
          prompt_hash, context_hash, plan_hash, temperature, seed,
          tool_versions_json, prompt, context_payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.generationId,
          record.lineageId,
          record.invocationId,
          record.contentHash,
          record.recordedAt,
          record.inputs.model.provider,
          record.inputs.model.model,
          record.inputs.model.version ?? null,
          record.inputs.promptHash,
          record.inputs.contextHash,
          record.inputs.planHash,
          record.inputs.temperature,
          record.inputs.seed ?? null,
          JSON.stringify(record.inputs.toolVersions),
          material.prompt,
          JSON.stringify(material.context),
        ],
      );
      return ok(undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes("UNIQUE constraint failed")) {
        return err({
          kind: "duplicate_generation",
          generationId: record.generationId,
        });
      }
      return err({ kind: "database_error", detail });
    }
  };

  const queryOne = (sql: string, param: string): StoredGeneration | undefined => {
    const row = db.query(sql).get(param) as GenerationRecordRow | null;
    return row === null ? undefined : parseStoredGeneration(row);
  };

  const getByGenerationId = (
    generationId: GenerationId,
  ): Result<StoredGeneration | undefined, ProvenanceStoreError> => {
    try {
      return ok(queryOne("SELECT * FROM generation_records WHERE generation_id = ?", generationId));
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const getByInvocationId = (
    invocationId: InvocationId,
  ): Result<StoredGeneration | undefined, ProvenanceStoreError> => {
    try {
      return ok(
        queryOne("SELECT * FROM generation_records WHERE invocation_id = ? LIMIT 1", invocationId),
      );
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const verifyContextHash = (generationId: GenerationId): Result<boolean, ProvenanceStoreError> => {
    const stored = getByGenerationId(generationId);
    if (!stored.ok) return stored;
    if (stored.value === undefined) return ok(false);

    const recomputed = computeContextHash(stored.value.material.context);
    return ok(contentHashEquals(recomputed, stored.value.record.inputs.contextHash));
  };

  return {
    dbPath,
    insert,
    getByGenerationId,
    getByInvocationId,
    verifyContextHash,
    close: () => db.close(),
  };
};

export { verifyGenerationInputs };
