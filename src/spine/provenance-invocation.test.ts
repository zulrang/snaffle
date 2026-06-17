import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationId, InvocationId, LineageId } from "../domain/ids";
import { openProvenanceStore } from "../lib/provenance-store";
import { STUB_MODEL_ID } from "../pi/invoke-stub-agent";
import { logStubGeneration } from "./provenance-invocation";
import { invokeValidatedStubAgent } from "./stub-invocation";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
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
    const dbPath = join(workspaceRoot, ".orchestrator", "provenance.sqlite");
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
        targetPath,
        content,
        metadata: outcome.metadata,
      }),
    );

    expect(logged.inputs.model.model).toBe(STUB_MODEL_ID);

    const stored = must(store.getByGenerationId(generationId));
    expect(stored?.record.invocationId).toBe(invocationId);
    expect(must(store.verifyContextHash(generationId))).toBe(true);
  });
});
