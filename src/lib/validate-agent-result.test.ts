import { describe, expect, test } from "bun:test";
import { InvocationId } from "../domain/ids";
import { parseRepoPath } from "../domain/scope";
import { validateAgentResult } from "./validate-agent-result";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const invocationId = must(InvocationId("inv-validate-1"));
const path = must(parseRepoPath("src/domain/gate.ts"));

const wellFormed = {
  invocationId,
  agentKind: "stub" as const,
  outcome: "succeeded" as const,
  edits: [{ path, operation: "modify" as const }],
  summary: "Applied edit",
};

describe("validateAgentResult", () => {
  test("accepts a well-formed agent result", () => {
    const validated = must(validateAgentResult(wellFormed, invocationId));

    expect(validated).toEqual(wellFormed);
  });

  test("rejects a malformed result rather than acting on it", () => {
    const malformed = {
      invocationId,
      agentKind: "not_an_agent",
      outcome: "succeeded",
      edits: [{ path: "src/x.ts", operation: "modify" }],
      summary: "bad kind",
    };

    const result = validateAgentResult(malformed, invocationId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected malformed rejection");
    expect(result.error.kind).toBe("malformed");
    expect(result.error.reason).toContain("agentKind");
  });

  test("rejects invocation id mismatch", () => {
    const result = validateAgentResult(wellFormed, must(InvocationId("inv-other")));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected mismatch rejection");
    expect(result.error.reason).toContain("invocationId mismatch");
  });

  test("rejects refused outcome with edits", () => {
    const result = validateAgentResult(
      {
        ...wellFormed,
        outcome: "refused",
        edits: [{ path, operation: "modify" }],
        summary: "declined",
      },
      invocationId,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected consistency rejection");
    expect(result.error.reason).toContain("refused outcome must not carry edits");
  });

  test("rejects succeeded outcome with no edits", () => {
    const result = validateAgentResult(
      {
        ...wellFormed,
        edits: [],
      },
      invocationId,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected consistency rejection");
    expect(result.error.reason).toContain("succeeded outcome must include at least one edit");
  });
});
