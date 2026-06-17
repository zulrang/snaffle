import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { classifyOneWay, classifyTwoWay } from "../domain/door";
import { GateRunId, LineageId, RequirementId, TransitionId } from "../domain/ids";
import { freezeAcceptanceTarget, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { planForRegime } from "../lib/regime-plan";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { type PreparedWorktreeGate, prepareWorktreeGate } from "./gate-invocation";
import { type PhaseTask, runLineageForRegime, runLineagePipeline } from "./phase-pipeline";

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
    lineageId: must(LineageId(`lineage-w5-${suffix}`)),
    requirementId: must(RequirementId(`req-w5-${suffix}`)),
    door,
    acceptanceTarget: must(
      freezeAcceptanceTarget({
        targetHash: must(parseContentHash("c".repeat(64))),
        criteria: [{ id: "c1", statement: "pipeline drives the lineage to its terminal" }],
        frozenAt: ts,
      }),
    ),
    declaredScope: scope,
    createdAt: ts,
  });

const idsFor = (suffix: string) => ({
  invocationBase: `inv-w5-${suffix}`,
  transitionId: must(TransitionId(`tr-w5-${suffix}`)),
  postGateRunId: must(GateRunId(`gate-w5-${suffix}-post`)),
});

const featureWrite: PhaseTask = {
  prompt: "Apply the minimal in-scope change.",
  writes: [{ path: "src/lib/w5-feature.ts", content: "// w5 feature\n" }],
};

const failingFixtureWrite: PhaseTask = {
  prompt: "Apply a change that breaks the gate fixture.",
  writes: [
    {
      path: "src/lib/w8-gate-fixture.test.ts",
      content: [
        'import { describe, expect, test } from "bun:test";',
        'describe("w8 gate fixture", () => {',
        '  test("fails post-apply", () => { expect(1).toBe(2); });',
        "});",
        "",
      ].join("\n"),
    },
  ],
};

describe("W5 — phase pipeline runner (D §8, D19)", () => {
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

  test("a two-way change runs minimal (implement → validate) and auto-merges on green", async () => {
    const gate = await prepare();
    const outcome = must(
      await runLineagePipeline({
        repoRoot,
        gate,
        lineage: makeLineageFor("merge", classifyTwoWay()),
        plan: planForRegime("minimal", { oracleCovered: true }),
        config,
        tasks: { implement: featureWrite },
        ids: idsFor("merge"),
        at: ts,
      }),
    );

    expect(outcome.phases.map((p) => p.phase)).toEqual(["implement", "validate"]);
    expect(outcome.terminal.kind).toBe("merged");
  });

  test("a one-way change runs full (spec → plan → oracle → implement → validate) and holds for human", async () => {
    const gate = await prepare();
    const outcome = must(
      await runLineagePipeline({
        repoRoot,
        gate,
        lineage: makeLineageFor("oneway", must(classifyOneWay(["money"]))),
        plan: planForRegime("full"),
        config,
        tasks: {
          spec: {
            prompt: "Author the acceptance target.",
            writes: [{ path: "src/domain/w5-spec.md", content: "# spec\n" }],
          },
          plan: {
            prompt: "Decompose into work items.",
            writes: [{ path: "src/domain/w5-plan.md", content: "# plan\n" }],
          },
          oracle_authoring: {
            prompt: "Author the frozen oracle.",
            writes: [
              {
                path: "tests/w5.oracle.test.ts",
                content:
                  'import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n',
              },
            ],
          },
          implement: featureWrite,
        },
        oraclePaths: ["tests/w5.oracle.test.ts"],
        ids: idsFor("oneway"),
        at: ts,
      }),
    );

    expect(outcome.phases.map((p) => p.phase)).toEqual([
      "spec",
      "plan",
      "oracle_authoring",
      "implement",
      "validate",
    ]);
    expect(outcome.terminal.kind).toBe("awaiting_human");
  });

  test("a stateful one-way change runs expand/contract phases before implement (W3, D9)", async () => {
    const gate = await prepare();
    const outcome = must(
      await runLineageForRegime({
        repoRoot,
        gate,
        lineage: makeLineageFor("stateful", must(classifyOneWay(["persisted_schema"]))),
        config,
        coverage: { kind: "reuse", coveredCriteria: ["c1"] },
        tasks: {
          spec: {
            prompt: "Author the acceptance target.",
            writes: [{ path: "src/domain/w5-spec-stateful.md", content: "# spec\n" }],
          },
          plan: {
            prompt: "Decompose into work items.",
            writes: [{ path: "src/domain/w5-plan-stateful.md", content: "# plan\n" }],
          },
          oracle_authoring: {
            prompt: "Author the frozen oracle.",
            writes: [
              {
                path: "tests/w5-stateful.oracle.test.ts",
                content:
                  'import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n',
              },
            ],
          },
          implement: featureWrite,
        },
        oraclePaths: ["tests/w5-stateful.oracle.test.ts"],
        ids: idsFor("stateful"),
        at: ts,
      }),
    );

    const phaseNames = outcome.phases.map((p) => p.phase);
    expect(phaseNames).toContain("expand");
    expect(phaseNames).toContain("contract");
    expect(phaseNames.indexOf("contract")).toBeLessThan(phaseNames.indexOf("implement"));
    expect(outcome.terminal.kind).toBe("awaiting_human");
  });

  test("a red validate gate is classified and routed between phases, never merged", async () => {
    const gate = await prepare();
    const outcome = must(
      await runLineagePipeline({
        repoRoot,
        gate,
        lineage: makeLineageFor("red", classifyTwoWay()),
        plan: planForRegime("minimal", { oracleCovered: true }),
        config,
        tasks: { implement: failingFixtureWrite },
        ids: idsFor("red"),
        at: ts,
      }),
    );

    expect(outcome.terminal.kind).toBe("failure_routed");
    if (outcome.terminal.kind !== "failure_routed") return;
    expect(outcome.terminal.verdict).toBeDefined();
    expect(outcome.terminal.action).toBeDefined();
    expect(outcome.terminal.state.status).not.toBe("merged");
  });
});
