import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyTwoWay } from "../domain/door";
import { GateRunId, LineageId, RequirementId, TransitionId } from "../domain/ids";
import { freezeAcceptanceTarget, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import type { OracleCoverageDecision } from "../lib/oracle-coverage";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { planForRegime } from "../lib/regime-plan";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { type PreparedWorktreeGate, prepareWorktreeGate } from "./gate-invocation";
import { runLineageForRegime, SPIKE_THROWAWAY_PATH } from "./phase-pipeline";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");
const ts = must(parseTimestamp(1_700_000_000_000));
const config = defaultOrchestratorConfig();
const scope = must(makeWriteScope([must(parseRepoPath("src/lib"))]));
const reuse: OracleCoverageDecision = { kind: "reuse", coveredCriteria: ["c1"] };

const lineage = makeLineage({
  lineageId: must(LineageId("lineage-w8-spike")),
  requirementId: must(RequirementId("req-w8-spike")),
  door: classifyTwoWay(),
  acceptanceTarget: must(
    freezeAcceptanceTarget({
      targetHash: must(parseContentHash("e".repeat(64))),
      criteria: [{ id: "c1", statement: "spike retires the open question" }],
      frozenAt: ts,
    }),
  ),
  declaredScope: scope,
  createdAt: ts,
});

describe("W8 — spiker phase trigger (D25)", () => {
  let prepared: PreparedWorktreeGate | undefined;
  afterEach(async () => {
    if (prepared) {
      await prepared.dispose();
      prepared = undefined;
    }
  });

  test("the spike runs only when an open question is declared", () => {
    expect(planForRegime("minimal", { oracleCovered: true }).phases).not.toContain("spike");
    expect(
      planForRegime("minimal", { oracleCovered: true, hasOpenQuestion: true }).phases,
    ).toContain("spike");
  });

  test("a declared open question runs the spiker before implement, in a throwaway scope never applied", async () => {
    const worktree = must(await prepareWorktreeGate(repoRoot));
    prepared = worktree;
    writePassingGateFixture(worktree.worktreeRoot);

    const outcome = must(
      await runLineageForRegime({
        repoRoot,
        gate: { worktreeRoot: worktree.worktreeRoot, config: skeletonGateConfig() },
        lineage,
        config,
        coverage: reuse,
        hasOpenQuestion: true,
        tasks: {
          spike: {
            prompt: "Retire the open question with throwaway code.",
            writes: [{ path: `${SPIKE_THROWAWAY_PATH}/scratch.ts`, content: "// throwaway\n" }],
          },
          implement: {
            prompt: "Apply the minimal in-scope change.",
            writes: [{ path: "src/lib/w8-spike-feature.ts", content: "// feature\n" }],
          },
        },
        ids: {
          invocationBase: "inv-w8-spike",
          transitionId: must(TransitionId("tr-w8-spike")),
          postGateRunId: must(GateRunId("gate-w8-spike-post")),
        },
        at: ts,
      }),
    );

    const order = outcome.phases.map((p) => p.phase);
    expect(order).toEqual(["spike", "implement", "validate"]);
    expect(order.indexOf("spike")).toBeLessThan(order.indexOf("implement"));

    const spikePhase = outcome.phases.find((p) => p.phase === "spike");
    expect(spikePhase?.agentKind).toBe("spiker");
    expect(spikePhase?.outcome).toBe("succeeded");
    expect(outcome.terminal.kind).toBe("merged");

    // The spiker's throwaway write is never applied as the change.
    expect(existsSync(join(worktree.worktreeRoot, SPIKE_THROWAWAY_PATH, "scratch.ts"))).toBe(false);
  });
});
