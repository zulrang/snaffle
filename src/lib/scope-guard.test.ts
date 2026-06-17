import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import {
  checkMutationAllowed,
  evaluateToolCallUnderScope,
  resolveRepoPathInWorkspace,
} from "./scope-guard";

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

describe("scope guard — path escape vectors (D6)", () => {
  const escapeVectors: readonly { readonly label: string; readonly path: string }[] = [
    { label: "plain sibling", path: "src/secrets/forbidden.ts" },
    { label: "absolute path", path: "/etc/passwd" },
    { label: "parent traversal", path: "src/domain/../../secrets/forbidden.ts" },
    {
      label: "redundant separators and dot segments",
      path: "src//domain/.././../secrets/forbidden.ts",
    },
    { label: "case variant", path: "SRC/SECRETS/forbidden.ts" },
  ];

  for (const vector of escapeVectors) {
    test(`blocks ${vector.label}: ${vector.path}`, () => {
      const denial = checkMutationAllowed(scope, "scoped_write", vector.path);
      expect(denial?.kind).toBe("scope_denied");
    });
  }

  test("normalizes redundant in-scope segments before allowing", () => {
    const denial = checkMutationAllowed(scope, "scoped_write", "./src/./domain///allowed.ts");
    expect(denial).toBeUndefined();
  });
});

describe("scope guard — symlink escape (D6)", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("resolveRepoPathInWorkspace follows a symlink out of scope", () => {
    workspace = mkdtempSync(join(tmpdir(), "orchestrator-scope-symlink-"));
    mkdirSync(join(workspace, "src/domain"), { recursive: true });
    mkdirSync(join(workspace, "src/secrets"), { recursive: true });
    symlinkSync(join(workspace, "src/secrets"), join(workspace, "src/domain/escape"));

    const logical = must(parseRepoPath("src/domain/escape/pwned.ts"));
    const resolved = resolveRepoPathInWorkspace(workspace, logical);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected resolve");
    expect(resolved.value).toBe(must(parseRepoPath("src/secrets/pwned.ts")));
  });

  test("blocks writes whose symlink target resolves outside scope", () => {
    workspace = mkdtempSync(join(tmpdir(), "orchestrator-scope-symlink-"));
    mkdirSync(join(workspace, "src/domain"), { recursive: true });
    mkdirSync(join(workspace, "src/secrets"), { recursive: true });
    symlinkSync(join(workspace, "src/secrets"), join(workspace, "src/domain/escape"));

    const denial = checkMutationAllowed(
      scope,
      "scoped_write",
      "src/domain/escape/pwned.ts",
      workspace,
    );
    expect(denial?.kind).toBe("scope_denied");
    expect(denial?.reason).toContain("resolves outside the granted scope");
  });
});
