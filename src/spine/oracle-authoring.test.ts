import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvocationId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { contentHashEquals } from "../domain/shared";
import { AGENT_DEFINITIONS } from "../lib/agents";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import {
  buildGenerationInputs,
  computeContextHash,
  computeGenerationContentHash,
  stubGenerationContextFromTask,
  verifyGenerationInputs,
} from "../lib/provenance-hash";
import { invokeAgent } from "./invoke-agent";
import { runOracleAuthoringPhase } from "./oracle-authoring";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");
const config = defaultOrchestratorConfig();
const ORACLE_PATH = "tests/feature.oracle.test.ts";
const ORACLE_BODY =
  'import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n';

describe("W4 — oracle-authoring phase (D7)", () => {
  let worktree: string;
  afterEach(() => {
    if (worktree) rmSync(worktree, { recursive: true, force: true });
  });

  test("the oracle is authored, frozen, and hashed before any implementer runs", async () => {
    worktree = mkdtempSync(join(tmpdir(), "w4-phase-"));
    const outcome = must(
      await runOracleAuthoringPhase({
        worktreeRoot: worktree,
        invocationId: must(InvocationId("inv-w4-author")),
        oraclePaths: [ORACLE_PATH],
        oracleWrites: [{ path: ORACLE_PATH, content: ORACLE_BODY }],
        config,
        repoRoot,
        frozenAt: 1,
      }),
    );

    expect(outcome.agentResult.agentKind).toBe("test_author");
    expect(outcome.agentResult.outcome).toBe("succeeded");
    expect(Object.keys(outcome.freeze.paths)).toContain(ORACLE_PATH);
    expect(outcome.freeze.hash).toBeDefined();
  });

  test("an implementer edit to a frozen oracle path is hard-rejected (D7 read-only)", async () => {
    worktree = mkdtempSync(join(tmpdir(), "w4-impl-"));
    const authoring = must(
      await runOracleAuthoringPhase({
        worktreeRoot: worktree,
        invocationId: must(InvocationId("inv-w4-author2")),
        oraclePaths: [ORACLE_PATH],
        oracleWrites: [{ path: ORACLE_PATH, content: ORACLE_BODY }],
        config,
        repoRoot,
        frozenAt: 1,
      }),
    );

    const implScope = must(makeWriteScope([must(parseRepoPath("tests"))]));
    const tampered = must(
      await invokeAgent({
        definition: AGENT_DEFINITIONS.implementer,
        invocationId: must(InvocationId("inv-w4-impl")),
        prompt: "Weaken the oracle so the change passes.",
        writes: [{ path: ORACLE_PATH, content: "// tampered\n" }],
        scope: implScope,
        config,
        repoRoot,
        workspaceRoot: worktree,
        oracleFreeze: authoring.freeze,
      }),
    );

    expect(tampered.agentResult.outcome).toBe("refused");
    expect(tampered.agentResult.edits).toHaveLength(0);
    expect(
      tampered.scopeEvents.some(
        (event) => event.kind === "write_denied" && /frozen|oracle|read-only/i.test(event.reason),
      ),
    ).toBe(true);
  });

  test("the frozen oracle hash is bound into the implementer's provenance (D10)", async () => {
    worktree = mkdtempSync(join(tmpdir(), "w4-prov-"));
    const authoring = must(
      await runOracleAuthoringPhase({
        worktreeRoot: worktree,
        invocationId: must(InvocationId("inv-w4-author3")),
        oraclePaths: [ORACLE_PATH],
        oracleWrites: [{ path: ORACLE_PATH, content: ORACLE_BODY }],
        config,
        repoRoot,
        frozenAt: 1,
      }),
    );

    const implScope = must(makeWriteScope([must(parseRepoPath("src/lib"))]));
    const impl = must(
      await invokeAgent({
        definition: AGENT_DEFINITIONS.implementer,
        invocationId: must(InvocationId("inv-w4-impl2")),
        prompt: "Apply the minimal in-scope change.",
        writes: [{ path: "src/lib/w4-feature.ts", content: "// feature\n" }],
        scope: implScope,
        config,
        repoRoot,
        workspaceRoot: worktree,
        oracleFreeze: authoring.freeze,
      }),
    );

    const context = stubGenerationContextFromTask({
      writes: [{ path: "src/lib/w4-feature.ts", content: "// feature\n" }],
      scope: implScope,
      oracleHash: authoring.freeze.hash,
    });
    const withoutOracle = stubGenerationContextFromTask({
      writes: [{ path: "src/lib/w4-feature.ts", content: "// feature\n" }],
      scope: implScope,
    });

    // The oracle hash is a distinct, hashed provenance input — not silently dropped.
    expect(context.oracleHash).toBe(String(authoring.freeze.hash));
    expect(contentHashEquals(computeContextHash(context), computeContextHash(withoutOracle))).toBe(
      false,
    );

    // It survives a content-addressed round-trip verify (D10 replay-audit).
    const inputs = buildGenerationInputs({ metadata: impl.metadata, prompt: "p", context });
    const verified = verifyGenerationInputs(inputs, computeGenerationContentHash(inputs), {
      prompt: "p",
      context,
    });
    expect(verified.ok).toBe(true);
  });
});
