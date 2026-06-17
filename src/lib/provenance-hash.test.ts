import { describe, expect, test } from "bun:test";
import {
  computeContextHash,
  computeGenerationContentHash,
  computePromptHash,
  hashCanonicalJson,
  stubGenerationContextFromTask,
  verifyGenerationInputs,
} from "./provenance-hash";

describe("provenance-hash", () => {
  test("canonical JSON hashing is stable across key order", () => {
    const a = hashCanonicalJson({ b: 2, a: 1 });
    const b = hashCanonicalJson({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  test("context hash recomputes from stored context material", () => {
    const context = stubGenerationContextFromTask({
      writes: [{ path: "src/domain/gate.ts", content: "// edit\n" }],
    });
    const inputs = {
      model: { provider: "orchestrator-stub", model: "orchestrator-stub-v1", version: "0.74.0" },
      promptHash: computePromptHash("Apply edit"),
      contextHash: computeContextHash(context),
      planHash: hashCanonicalJson({ phase: 1, kind: "skeleton" }),
      temperature: 0,
      toolVersions: { "pi-agent-core": "0.74.0", "pi-ai": "0.74.0" },
    };
    const contentHash = computeGenerationContentHash(inputs);
    const verified = verifyGenerationInputs(inputs, contentHash, {
      prompt: "Apply edit",
      context,
    });
    expect(verified.ok).toBe(true);
  });

  test("content hash binds Pi SDK tool versions, not only the model ref", () => {
    const context = stubGenerationContextFromTask({
      writes: [{ path: "src/domain/gate.ts", content: "// edit\n" }],
    });
    const baseInputs = {
      model: { provider: "orchestrator-stub", model: "orchestrator-stub-v1", version: "0.74.0" },
      promptHash: computePromptHash("Apply edit"),
      contextHash: computeContextHash(context),
      planHash: hashCanonicalJson({ phase: 1, kind: "skeleton" }),
      temperature: 0,
      toolVersions: { "pi-agent-core": "0.74.0", "pi-ai": "0.74.0" },
    };
    const contentHash = computeGenerationContentHash(baseInputs);

    const sdkTamper = verifyGenerationInputs(
      { ...baseInputs, toolVersions: { "pi-agent-core": "9.9.9", "pi-ai": "0.74.0" } },
      contentHash,
      { prompt: "Apply edit", context },
    );
    expect(sdkTamper.ok).toBe(false);
    if (sdkTamper.ok) throw new Error("expected SDK tamper mismatch");
    expect(sdkTamper.error.kind).toBe("content_hash_mismatch");
  });
});
