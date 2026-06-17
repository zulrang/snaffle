import { describe, expect, test } from "bun:test";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { evaluateToolCallUnderScope } from "./scope-guard";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const scope = must(makeWriteScope([must(parseRepoPath("src/domain"))]));

describe("scope guard — fail closed", () => {
  test("blocks unknown tools under a write grant", () => {
    const denial = evaluateToolCallUnderScope(scope, "bash", { command: "rm -rf /" });
    expect(denial?.kind).toBe("scope_denied");
    expect(denial?.reason).toContain("not permitted");
  });

  test("blocks mutation tools with a missing path argument", () => {
    const denial = evaluateToolCallUnderScope(scope, "write", { content: "x" });
    expect(denial?.kind).toBe("scope_denied");
    expect(denial?.reason).toContain("requires a string path");
  });

  test("blocks mutation tools with a non-string path", () => {
    const denial = evaluateToolCallUnderScope(scope, "scoped_write", { path: ["src/a.ts"] });
    expect(denial?.kind).toBe("scope_denied");
    expect(denial?.reason).toContain("requires a string path");
  });

  test("allows in-scope scoped_write", () => {
    const denial = evaluateToolCallUnderScope(scope, "scoped_write", {
      path: "src/domain/gate.ts",
      content: "x",
    });
    expect(denial).toBeUndefined();
  });
});
