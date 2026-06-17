import { describe, expect, test } from "bun:test";
import { InvocationId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import {
  invokeStubAgent,
  STUB_MODEL_ID,
  STUB_MODEL_VERSION,
  stubResultToAgentResult,
} from "../pi/invoke-stub-agent";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const invocationId = must(InvocationId("inv-s1-1"));
const scope = must(makeWriteScope([must(parseRepoPath("src/domain"))]));

describe("S1 — Pi SDK headless invocation shape", () => {
  test("invoking a stub task yields a deterministically-shaped result from a pinned model", async () => {
    const result = must(
      await invokeStubAgent({
        invocationId,
        prompt: "Apply a trivial edit to src/domain/gate.ts",
        targetPath: "src/domain/gate.ts",
        content: "// spike edit\n",
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.invocationId).toBe(invocationId);
    expect(result.edits).toEqual([
      {
        path: must(parseRepoPath("src/domain/gate.ts")),
        operation: "modify",
      },
    ]);
    expect(result.metadata).toEqual({
      provider: "orchestrator-stub",
      modelId: STUB_MODEL_ID,
      modelVersion: STUB_MODEL_VERSION,
      sdkVersions: {
        piAgentCore: "0.74.0",
        piAi: "0.74.0",
      },
    });
    expect(result.summary).toContain("src/domain/gate.ts");

    const agentResult = stubResultToAgentResult(result);
    expect(agentResult.agentKind).toBe("stub");
    expect(agentResult.outcome).toBe("succeeded");
    expect(agentResult.edits).toHaveLength(1);
  });

  test("rejects an invalid target path before invoking the agent", async () => {
    const result = await invokeStubAgent({
      invocationId: must(InvocationId("inv-s1-bad-path")),
      prompt: "nope",
      targetPath: "../escape.ts",
      content: "x",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("invalid_target_path");
  });
});

describe("S1 — scope enforcement hook (feeds into S2)", () => {
  test("an out-of-scope write is refused and surfaced to the orchestrator", async () => {
    let denial: { reason: string; path: string } | undefined;

    const result = must(
      await invokeStubAgent(
        {
          invocationId: must(InvocationId("inv-s1-oos")),
          prompt: "Try to write outside scope",
          targetPath: "src/secrets/env.ts",
          content: "leak",
        },
        {
          scope,
          onScopeDenial: (d) => {
            denial = d;
          },
        },
      ),
    );

    expect(result.status).toBe("refused");
    expect(result.edits).toHaveLength(0);
    expect(denial?.path).toBe("src/secrets/env.ts");
    expect(denial?.reason).toContain("outside the granted scope");
  });
});
