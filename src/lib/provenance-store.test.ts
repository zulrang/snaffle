import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationId, InvocationId, LineageId } from "../domain/ids";
import { makeGenerationRecord } from "../domain/provenance";
import { parseTimestamp } from "../domain/shared";
import { STUB_MODEL_ID, STUB_MODEL_VERSION } from "../pi/invoke-stub-agent";
import {
  buildGenerationInputs,
  computeContextHash,
  computeGenerationContentHash,
  stubGenerationContextFromTask,
} from "./provenance-hash";
import { openProvenanceStore } from "./provenance-store";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W7 — SQLite provenance store (D10)", () => {
  let workspaceRoot: string;
  let dbPath: string;
  let store: ReturnType<typeof openProvenanceStore>;

  afterEach(() => {
    store?.close();
    if (workspaceRoot) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("generation record is queryable and context hash recomputes from stored inputs", () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "orchestrator-w7-"));
    dbPath = join(workspaceRoot, ".orchestrator", "provenance.sqlite");
    store = openProvenanceStore(dbPath);

    const prompt = "Apply a trivial edit to src/domain/gate.ts";
    const context = stubGenerationContextFromTask({
      writes: [{ path: "src/domain/gate.ts", content: "// w7 edit\n" }],
    });
    const metadata = {
      provider: "orchestrator-stub",
      modelId: STUB_MODEL_ID,
      modelVersion: STUB_MODEL_VERSION,
      sdkVersions: { piAgentCore: "0.74.0", piAi: "0.74.0" },
    };
    const inputs = buildGenerationInputs({ metadata, prompt, context });
    const contentHash = computeGenerationContentHash(inputs);
    const generationId = must(GenerationId("gen-w7-trivial"));
    const lineageId = must(LineageId("lineage-w7"));
    const invocationId = must(InvocationId("inv-w7-trivial"));
    const recordedAt = must(parseTimestamp(1_700_000_000_000));

    const record = must(
      makeGenerationRecord({
        generationId,
        lineageId,
        invocationId,
        inputs,
        contentHash,
        recordedAt,
      }),
    );

    must(store.insert(record, { prompt, context }));

    const byId = must(store.getByGenerationId(generationId));
    expect(byId?.record.generationId).toBe(generationId);
    expect(byId?.record.inputs.contextHash).toBe(computeContextHash(context));

    const byInvocation = must(store.getByInvocationId(invocationId));
    expect(byInvocation?.record.generationId).toBe(generationId);

    expect(must(store.verifyGenerationRecord(generationId))).toBe(true);
  });

  test("detects tampered prompt material on read-back", () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "orchestrator-w7-"));
    dbPath = join(workspaceRoot, ".orchestrator", "provenance.sqlite");
    store = openProvenanceStore(dbPath);

    const prompt = "original prompt";
    const context = stubGenerationContextFromTask({
      writes: [{ path: "src/domain/gate.ts", content: "// edit\n" }],
    });
    const metadata = {
      provider: "orchestrator-stub",
      modelId: STUB_MODEL_ID,
      modelVersion: STUB_MODEL_VERSION,
      sdkVersions: { piAgentCore: "0.74.0", piAi: "0.74.0" },
    };
    const inputs = buildGenerationInputs({ metadata, prompt, context });
    const contentHash = computeGenerationContentHash(inputs);
    const generationId = must(GenerationId("gen-w7-tamper"));
    const lineageId = must(LineageId("lineage-w7"));
    const invocationId = must(InvocationId("inv-w7-tamper"));
    const recordedAt = must(parseTimestamp(1_700_000_000_001));

    const record = must(
      makeGenerationRecord({
        generationId,
        lineageId,
        invocationId,
        inputs,
        contentHash,
        recordedAt,
      }),
    );

    must(store.insert(record, { prompt: "tampered prompt", context }));
    expect(must(store.verifyGenerationRecord(generationId))).toBe(false);
  });
});
