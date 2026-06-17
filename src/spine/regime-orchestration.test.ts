import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { classifyOneWay, classifyTwoWay } from "../domain/door";
import { GateRunId, LineageId, RequirementId, TransitionId } from "../domain/ids";
import { freezeAcceptanceTarget, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import type { OracleCoverageDecision } from "../lib/oracle-coverage";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { type PreparedWorktreeGate, prepareWorktreeGate } from "./gate-invocation";
import { type PhaseTask, runLineageForRegime } from "./phase-pipeline";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");
const ts = must(parseTimestamp(1_700_000_000_000));
const config = defaultOrchestratorConfig();
const scope = must(
  makeWriteScope([must(parseRepoPath("src/domain")), must(parseRepoPath("src/lib"))]),
);

const makeLineageFor = (suffix: string, door: ReturnType<typeof classifyTwoWay>) =>
  makeLineage({
    lineageId: must(LineageId(`lineage-w6-${suffix}`)),
    requirementId: must(RequirementId(`req-w6-${suffix}`)),
    door,
    acceptanceTarget: must(
      freezeAcceptanceTarget({
        targetHash: must(parseContentHash("d".repeat(64))),
        criteria: [{ id: "c1", statement: "regime selects the right phases" }],
        frozenAt: ts,
      }),
    ),
    declaredScope: scope,
    createdAt: ts,
  });

const idsFor = (suffix: string) => ({
  invocationBase: `inv-w6-${suffix}`,
  transitionId: must(TransitionId(`tr-w6-${suffix}`)),
  postGateRunId: must(GateRunId(`gate-w6-${suffix}-post`)),
});

const featureWrite: PhaseTask = {
  prompt: "Apply the minimal in-scope change.",
  writes: [{ path: "src/lib/w6-feature.ts", content: "// w6 feature\n" }],
};

const oracleTask: PhaseTask = {
  prompt: "Author the frozen oracle.",
  writes: [
    {
      path: "tests/w6.oracle.test.ts",
      content: 'import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n',
    },
  ],
};

const specPlanTasks = {
  spec: {
    prompt: "Author the acceptance target.",
    writes: [{ path: "src/domain/w6-spec.md", content: "# spec\n" }],
  },
  plan: {
    prompt: "Decompose into work items.",
    writes: [{ path: "src/domain/w6-plan.md", content: "# plan\n" }],
  },
} as const;

describe("W6 — regime orchestration (D25)", () => {
  let prepared: PreparedWorktreeGate | undefined;

  afterEach(async () => {
    if (prepared) {
      await prepared.dispose();
      prepared = undefined;
    }
  });

  const prepare = async () => {
    const worktree = must(await prepareWorktreeGate(repoRoot));
    prepared = worktree;
    writePassingGateFixture(worktree.worktreeRoot);
    return { worktreeRoot: worktree.worktreeRoot, config: skeletonGateConfig() };
  };

  const reuse: OracleCoverageDecision = { kind: "reuse", coveredCriteria: ["c1"] };
  const author: OracleCoverageDecision = {
    kind: "author",
    reason: "no_frozen_oracle",
    uncovered: ["c1"],
  };

  test("minimal-with-coverage skips the test-author and merges", async () => {
    const gate = await prepare();
    const outcome = must(
      await runLineageForRegime({
        repoRoot,
        gate,
        lineage: makeLineageFor("reuse", classifyTwoWay()),
        config,
        coverage: reuse,
        tasks: { implement: featureWrite },
        ids: idsFor("reuse"),
        at: ts,
      }),
    );

    expect(outcome.phases.map((p) => p.phase)).toEqual(["implement", "validate"]);
    expect(outcome.terminal.kind).toBe("merged");
  });

  test("minimal-without-coverage invokes the test-author before merging", async () => {
    const gate = await prepare();
    const outcome = must(
      await runLineageForRegime({
        repoRoot,
        gate,
        lineage: makeLineageFor("author", classifyTwoWay()),
        config,
        coverage: author,
        tasks: { oracle_authoring: oracleTask, implement: featureWrite },
        oraclePaths: ["tests/w6.oracle.test.ts"],
        ids: idsFor("author"),
        at: ts,
      }),
    );

    expect(outcome.phases.map((p) => p.phase)).toEqual([
      "oracle_authoring",
      "implement",
      "validate",
    ]);
    expect(outcome.terminal.kind).toBe("merged");
  });

  test("full authors the oracle and holds for human even when coverage would allow reuse", async () => {
    const gate = await prepare();
    const outcome = must(
      await runLineageForRegime({
        repoRoot,
        gate,
        lineage: makeLineageFor("full", must(classifyOneWay(["money"]))),
        config,
        coverage: reuse,
        tasks: { ...specPlanTasks, oracle_authoring: oracleTask, implement: featureWrite },
        oraclePaths: ["tests/w6.oracle.test.ts"],
        ids: idsFor("full"),
        at: ts,
      }),
    );

    expect(outcome.phases.map((p) => p.phase)).toContain("oracle_authoring");
    expect(outcome.phases.map((p) => p.phase)).toEqual([
      "spec",
      "plan",
      "oracle_authoring",
      "implement",
      "validate",
    ]);
    expect(outcome.terminal.kind).toBe("awaiting_human");
  });
});
