import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvocationId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { assembleSystemPrompt } from "../lib/agent-context";
import { buildOracleFreezeRecord, verifyOracleIntegrity } from "../lib/oracle-freeze";
import { loadSkill } from "../lib/skills";
import { invokeStubAgentSequence } from "../pi/invoke-stub-agent";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");
const ORACLE_PATH = "tests/feature.oracle.test.ts";
const ORACLE_BODY =
  'import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n';

/**
 * Phase 4 S2 — oracle authoring handoff (D7).
 *
 * Proves the gradee cannot touch its grader: the test-author authors the oracle;
 * the spine freezes + hashes it before the implementer runs; an implementer write
 * to a frozen-test path is denied by the same guard that enforces scope; and a
 * post-freeze edit is caught deterministically as oracle drift.
 */
describe("P4/S2 — test-author → freeze → implementer read-only (D7)", () => {
  let worktree: string;
  afterEach(() => {
    if (worktree) rmSync(worktree, { recursive: true, force: true });
  });

  test("test-author authors the oracle; the spine freezes + hashes it before the implementer runs", async () => {
    worktree = mkdtempSync(join(tmpdir(), "p4-s2-author-"));
    const skill = must(loadSkill("test-authoring", repoRoot));
    const systemPrompt = assembleSystemPrompt("test_author", [skill]);
    const testScope = must(makeWriteScope([must(parseRepoPath("tests"))]));

    const authored = must(
      await invokeStubAgentSequence(
        {
          invocationId: must(InvocationId("inv-p4-s2-author")),
          prompt: "Author the frozen acceptance oracle.",
          writes: [{ path: ORACLE_PATH, content: ORACLE_BODY }],
        },
        { scope: testScope, systemPrompt },
      ),
    );
    expect(authored.status).toBe("succeeded");
    expect(String(authored.edits[0]?.path)).toBe(ORACLE_PATH);

    // Spine applies the authored oracle, then freezes + hashes it (control plane, not the agent).
    mkdirSync(join(worktree, "tests"), { recursive: true });
    writeFileSync(join(worktree, ORACLE_PATH), ORACLE_BODY, "utf8");
    const freeze = must(buildOracleFreezeRecord(worktree, [ORACLE_PATH], 1));
    expect(Object.keys(freeze.paths)).toContain(ORACLE_PATH);
    expect(freeze.hash).toBeDefined();
  });

  test("the implementer cannot write a frozen-test path (D7 read-only)", async () => {
    worktree = mkdtempSync(join(tmpdir(), "p4-s2-impl-"));
    mkdirSync(join(worktree, "tests"), { recursive: true });
    writeFileSync(join(worktree, ORACLE_PATH), ORACLE_BODY, "utf8");
    const freeze = must(buildOracleFreezeRecord(worktree, [ORACLE_PATH], 1));

    const skill = must(loadSkill("implementation", repoRoot));
    // The implementer's grant spans the oracle path, but the frozen-oracle guard still wins.
    const implScope = must(makeWriteScope([must(parseRepoPath("tests"))]));

    const denials: string[] = [];
    const result = must(
      await invokeStubAgentSequence(
        {
          invocationId: must(InvocationId("inv-p4-s2-impl")),
          prompt: "Weaken the oracle so the change passes.",
          writes: [{ path: ORACLE_PATH, content: "// tampered\n" }],
        },
        {
          scope: implScope,
          systemPrompt: assembleSystemPrompt("implementer", [skill]),
          oracleFreeze: freeze,
          onScopeDenial: (denial) => denials.push(denial.reason),
        },
      ),
    );

    expect(result.status).toBe("refused");
    expect(result.edits).toHaveLength(0);
    expect(denials.some((reason) => /frozen|read-only|oracle/i.test(reason))).toBe(true);
  });

  test("a post-freeze edit to the oracle is caught as drift (oracle_touched)", () => {
    worktree = mkdtempSync(join(tmpdir(), "p4-s2-drift-"));
    mkdirSync(join(worktree, "tests"), { recursive: true });
    writeFileSync(join(worktree, ORACLE_PATH), ORACLE_BODY, "utf8");
    const freeze = must(buildOracleFreezeRecord(worktree, [ORACLE_PATH], 1));

    expect(verifyOracleIntegrity(worktree, freeze).ok).toBe(true);

    writeFileSync(join(worktree, ORACLE_PATH), "// quietly weakened\n", "utf8");
    const drift = verifyOracleIntegrity(worktree, freeze);
    expect(drift.ok).toBe(false);
    if (drift.ok) return;
    expect(drift.error.kind).toBe("oracle_touched");
  });
});
