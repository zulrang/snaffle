import { describe, expect, test } from "bun:test";
import { InvocationId } from "../domain/ids";
import { deriveMergeOutcome } from "../domain/transition";
import { validateAgentResult } from "../lib/validate-agent-result";
import { STUB_MODEL_ID, STUB_MODEL_VERSION } from "../pi/invoke-stub-agent";
import { invokeValidatedStubAgent } from "./stub-invocation";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W4 — stub-agent invocation with validated results (D14)", () => {
  test("for a trivial edit task the spine receives and validates a well-formed result", async () => {
    const invocationId = must(InvocationId("inv-w4-trivial"));
    const outcome = must(
      await invokeValidatedStubAgent({
        invocationId,
        prompt: "Apply a trivial edit to src/domain/gate.ts",
        targetPath: "src/domain/gate.ts",
        content: "// w4 edit\n",
      }),
    );

    expect(outcome.agentResult.invocationId).toBe(invocationId);
    expect(outcome.agentResult.agentKind).toBe("stub");
    expect(outcome.agentResult.outcome).toBe("succeeded");
    expect(outcome.agentResult.edits).toHaveLength(1);
    expect(outcome.agentResult.summary).toContain("src/domain/gate.ts");
    expect(outcome.metadata.modelId).toBe(STUB_MODEL_ID);
    expect(outcome.metadata.modelVersion).toBe(STUB_MODEL_VERSION);

    const revalidated = must(validateAgentResult(outcome.agentResult, invocationId));
    expect(revalidated).toEqual(outcome.agentResult);
  });

  test("a malformed result is rejected rather than acted on", () => {
    const malformed = {
      invocationId: must(InvocationId("inv-w4-bad")),
      agentKind: "stub",
      outcome: "succeeded",
      edits: [],
      summary: "empty edits on success",
    };

    const validated = validateAgentResult(malformed, must(InvocationId("inv-w4-bad")));
    expect(validated.ok).toBe(false);

    let mergeDerived = false;
    if (validated.ok) {
      deriveMergeOutcome({
        door: { direction: "two_way" },
        agentOutcome: validated.value.outcome,
        postGate: "green",
        scopeCompliant: true,
      });
      mergeDerived = true;
    }

    expect(mergeDerived).toBe(false);
    if (!validated.ok) {
      expect(validated.error.kind).toBe("malformed");
    }
  });
});
