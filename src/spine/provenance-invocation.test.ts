import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationId, InvocationId, LineageId } from "../domain/ids";
import {
  computeContextHash,
  computeGenerationContentHash,
  computePromptHash,
  verifyGenerationInputs,
} from "../lib/provenance-hash";
import { openProvenanceStore, type StoredGeneration } from "../lib/provenance-store";
import { STUB_MODEL_ID, STUB_MODEL_VERSION } from "../pi/invoke-stub-agent";
import { logStubGeneration } from "./provenance-invocation";
import { invokeValidatedStubAgent } from "./stub-invocation";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const mustStored = (stored: {
  ok: boolean;
  value?: StoredGeneration | undefined;
}): StoredGeneration => {
  const value = must(stored);
  if (value === undefined) throw new Error("expected stored generation");
  return value;
};

describe("W7 — provenance logging after stub invocation (D10)", () => {
  let workspaceRoot: string;
  let store: ReturnType<typeof openProvenanceStore>;

  afterEach(() => {
    store?.close();
    if (workspaceRoot) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("after a run the generation record is queryable with a verifiable context hash", async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "orchestrator-w7-spine-"));
    const dbPath = join(workspaceRoot, ".snaffle", "provenance.sqlite");
    store = openProvenanceStore(dbPath);

    const invocationId = must(InvocationId("inv-w7-spine"));
    const prompt = "Apply a trivial edit to src/domain/gate.ts";
    const targetPath = "src/domain/gate.ts";
    const content = "// w7 spine edit\n";

    const outcome = must(
      await invokeValidatedStubAgent({
        invocationId,
        prompt,
        targetPath,
        content,
      }),
    );

    const generationId = must(GenerationId("gen-w7-spine"));
    const logged = must(
      logStubGeneration(store, {
        generationId,
        lineageId: must(LineageId("lineage-w7-spine")),
        invocationId,
        prompt,
        writes: [{ path: targetPath, content }],
        metadata: outcome.metadata,
        agentResult: outcome.agentResult,
      }),
    );

    expect(logged.inputs.model.model).toBe(STUB_MODEL_ID);

    const stored = must(store.getByGenerationId(generationId));
    expect(stored?.record.invocationId).toBe(invocationId);
    expect(stored?.material.context.agentResult?.outcome).toBe("succeeded");
    expect(must(store.verifyGenerationRecord(generationId))).toBe(true);
  });
});

describe("D10 — provenance hash integrity after a run", () => {
  let workspaceRoot: string;
  let store: ReturnType<typeof openProvenanceStore>;

  afterEach(() => {
    store?.close();
    if (workspaceRoot) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("hand-recomputed context hash matches stored inputs; corruption is detected", async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "orchestrator-d10-"));
    const dbPath = join(workspaceRoot, ".snaffle", "provenance.sqlite");
    store = openProvenanceStore(dbPath);

    const invocationId = must(InvocationId("inv-d10-hand"));
    const prompt = "Apply a trivial edit to src/domain/gate.ts";
    const targetPath = "src/domain/gate.ts";
    const content = "// d10 edit\n";

    const outcome = must(
      await invokeValidatedStubAgent({ invocationId, prompt, targetPath, content }),
    );

    const generationId = must(GenerationId("gen-d10-hand"));
    must(
      logStubGeneration(store, {
        generationId,
        lineageId: must(LineageId("lineage-d10")),
        invocationId,
        prompt,
        writes: [{ path: targetPath, content }],
        metadata: outcome.metadata,
        agentResult: outcome.agentResult,
      }),
    );

    const stored = mustStored(store.getByGenerationId(generationId));
    const { record, material } = stored;

    const handContextHash = computeContextHash(material.context);
    expect(handContextHash).toBe(record.inputs.contextHash);

    const handPromptHash = computePromptHash(material.prompt);
    expect(handPromptHash).toBe(record.inputs.promptHash);

    const handContentHash = computeGenerationContentHash({
      ...record.inputs,
      promptHash: handPromptHash,
      contextHash: handContextHash,
    });
    expect(handContentHash).toBe(record.contentHash);

    const verified = verifyGenerationInputs(record.inputs, record.contentHash, material);
    expect(verified.ok).toBe(true);

    const corruptedContext = verifyGenerationInputs(record.inputs, record.contentHash, {
      prompt: material.prompt,
      context: {
        ...material.context,
        writes: [{ path: targetPath, content: "// tampered\n" }],
      },
    });
    expect(corruptedContext.ok).toBe(false);
    if (corruptedContext.ok) throw new Error("expected context corruption to fail");
    expect(corruptedContext.error.kind).toBe("context_hash_mismatch");

    const corruptedPrompt = verifyGenerationInputs(record.inputs, record.contentHash, {
      prompt: `${material.prompt} injected`,
      context: material.context,
    });
    expect(corruptedPrompt.ok).toBe(false);
    if (corruptedPrompt.ok) throw new Error("expected prompt corruption to fail");
    expect(corruptedPrompt.error.kind).toBe("content_hash_mismatch");
  });

  test("captures pinned Pi SDK tool versions and temp-0, not only the model ref", async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "orchestrator-d10-meta-"));
    const dbPath = join(workspaceRoot, ".snaffle", "provenance.sqlite");
    store = openProvenanceStore(dbPath);

    const invocationId = must(InvocationId("inv-d10-meta"));
    const prompt = "Capture full provenance inputs";
    const targetPath = "src/domain/gate.ts";
    const content = "// meta\n";

    const outcome = must(
      await invokeValidatedStubAgent({ invocationId, prompt, targetPath, content }),
    );

    const generationId = must(GenerationId("gen-d10-meta"));
    must(
      logStubGeneration(store, {
        generationId,
        lineageId: must(LineageId("lineage-d10-meta")),
        invocationId,
        prompt,
        writes: [{ path: targetPath, content }],
        metadata: outcome.metadata,
        agentResult: outcome.agentResult,
      }),
    );

    const stored = mustStored(store.getByGenerationId(generationId));
    expect(stored.record.inputs.model).toEqual({
      provider: "orchestrator-stub",
      model: STUB_MODEL_ID,
      version: STUB_MODEL_VERSION,
    });
    expect(stored.record.inputs.temperature).toBe(0);
    expect(stored.record.inputs.toolVersions).toEqual({
      "pi-agent-core": outcome.metadata.sdkVersions.piAgentCore,
      "pi-ai": outcome.metadata.sdkVersions.piAi,
    });
    expect(stored.record.inputs.toolVersions["pi-agent-core"]).toBe("0.74.0");
    expect(stored.record.inputs.toolVersions["pi-ai"]).toBe("0.74.0");

    const sdkTamper = verifyGenerationInputs(
      {
        ...stored.record.inputs,
        toolVersions: { "pi-agent-core": "9.9.9", "pi-ai": "0.74.0" },
      },
      stored.record.contentHash,
      stored.material,
    );
    expect(sdkTamper.ok).toBe(false);
    if (sdkTamper.ok) throw new Error("expected SDK version tamper to fail");
    expect(sdkTamper.error.kind).toBe("content_hash_mismatch");
  });
});
