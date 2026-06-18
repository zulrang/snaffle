import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyOneWay, classifyTwoWay } from "../domain/door";
import { DecisionId, GateRunId, LineageId, RequirementId, TransitionId } from "../domain/ids";
import { freezeAcceptanceTarget, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import { DECISION_DB_DIR, DECISION_DB_FILE, openDecisionQueueStore } from "../lib/decision-queue";
import { gateSpanPair, openGateSpanStore, SPAN_DB_DIR, SPAN_DB_FILE } from "../lib/gate-spans";
import { ESCAPE_DB_DIR, ESCAPE_DB_FILE, openOracleEscapeStore } from "../lib/oracle-escape";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { planForRegime } from "../lib/regime-plan";
import { type RolloutClient, runRolloutGuardrail } from "../lib/rollout-guardrail";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { recordDecisionForLineage } from "./decisions-cli";
import { reportEscapeClusters } from "./escapes-cli";
import { type PreparedWorktreeGate, prepareWorktreeGate } from "./gate-invocation";
import { type PhaseTask, runLineageForRegime, runLineagePipeline } from "./phase-pipeline";
import { gateSpanDbPath } from "./spine-wiring";

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

const featureWrite = (path: string): PhaseTask => ({
  prompt: "implement",
  writes: [{ path, content: `// ${path}\n` }],
});

describe("W12 — Phase 6 spine rollout integration", () => {
  let prepared: PreparedWorktreeGate | undefined;
  let tmpWorkspace: string | undefined;

  afterEach(async () => {
    if (prepared) {
      await prepared.dispose();
      prepared = undefined;
    }
    if (tmpWorkspace) {
      rmSync(tmpWorkspace, { recursive: true, force: true });
      tmpWorkspace = undefined;
    }
  });

  test("stateful one-way runs expand/contract before implement", async () => {
    const worktree = must(await prepareWorktreeGate(repoRoot));
    prepared = worktree;
    writePassingGateFixture(worktree.worktreeRoot);
    const gate = { worktreeRoot: worktree.worktreeRoot, config: skeletonGateConfig() };

    const outcome = must(
      await runLineageForRegime({
        repoRoot,
        gate,
        lineage: makeLineage({
          lineageId: must(LineageId("lineage-w12-stateful")),
          requirementId: must(RequirementId("req-w12")),
          door: must(classifyOneWay(["persisted_schema"])),
          acceptanceTarget: must(
            freezeAcceptanceTarget({
              targetHash: must(parseContentHash("b".repeat(64))),
              criteria: [{ id: "c1", statement: "stateful integration" }],
              frozenAt: ts,
            }),
          ),
          declaredScope: scope,
          createdAt: ts,
        }),
        config,
        coverage: { kind: "reuse", coveredCriteria: ["c1"] },
        tasks: {
          spec: {
            prompt: "spec",
            writes: [{ path: "src/domain/w12-spec.md", content: "# s\n" }],
          },
          plan: {
            prompt: "plan",
            writes: [{ path: "src/domain/w12-plan.md", content: "# p\n" }],
          },
          oracle_authoring: {
            prompt: "oracle",
            writes: [
              {
                path: "tests/w12.oracle.test.ts",
                content:
                  'import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n',
              },
            ],
          },
          implement: {
            prompt: "implement",
            writes: [{ path: "src/lib/w12.ts", content: "// w12\n" }],
          },
        },
        oraclePaths: ["tests/w12.oracle.test.ts"],
        ids: {
          invocationBase: "inv-w12",
          transitionId: must(TransitionId("tr-w12")),
          postGateRunId: must(GateRunId("gate-w12-post")),
        },
        at: ts,
      }),
    );

    const names = outcome.phases.map((p) => p.phase);
    expect(names).toContain("expand");
    expect(names.indexOf("contract")).toBeLessThan(names.indexOf("implement"));
  });

  test("metric breach rolls back and records an oracle escape", async () => {
    tmpWorkspace = mkdtempSync(join(tmpdir(), "w12-rollout-"));
    const dbPath = join(tmpWorkspace, ESCAPE_DB_DIR, ESCAPE_DB_FILE);
    mkdirSync(dirname(dbPath), { recursive: true });

    let rolledBack = false;
    const client: RolloutClient = {
      arm: async () => {},
      pollMetric: async () => 0.99,
      rollback: async () => {
        rolledBack = true;
      },
    };

    const guardrail = must(
      await runRolloutGuardrail({
        lineageId: "L-w12",
        config: { flagName: "f", metricRef: "err", threshold: 0.1 },
        client,
      }),
    );
    expect(guardrail.kind).toBe("rolled_back");
    expect(rolledBack).toBe(true);

    const store = openOracleEscapeStore(dbPath);
    must(
      store.recordEscape({
        lineageId: must(LineageId("L-w12")),
        missedCriterion: "c1",
        source: "metric",
        recordedAt: ts,
      }),
    );
    store.close();

    const clusters = must(reportEscapeClusters(tmpWorkspace));
    expect(clusters.clusters).toHaveLength(1);
  });

  test("gate spans attribute PRE/POST to one lineage", () => {
    tmpWorkspace = mkdtempSync(join(tmpdir(), "w12-spans-"));
    const dbPath = join(tmpWorkspace, SPAN_DB_DIR, SPAN_DB_FILE);
    mkdirSync(dirname(dbPath), { recursive: true });
    const store = openGateSpanStore(dbPath);
    const gateRunId = must(GateRunId("gate-w12-span"));
    const lineageId = must(LineageId("L-w12-span"));
    const ended = must(parseTimestamp(1_700_000_000_100));

    for (const span of gateSpanPair({
      gateRunId,
      lineageId,
      at: ts,
      postOutcome: "green",
      endedAt: ended,
    })) {
      must(store.recordSpan(span));
    }
    expect(must(store.listByLineage(lineageId))).toHaveLength(2);
    store.close();
  });

  test("auto-merge wires gate spans and post-merge rollout on default pipeline path", async () => {
    const worktree = must(await prepareWorktreeGate(repoRoot));
    prepared = worktree;
    writePassingGateFixture(worktree.worktreeRoot);
    const gate = { worktreeRoot: worktree.worktreeRoot, config: skeletonGateConfig() };
    const lineageId = must(LineageId("lineage-w12-rollout"));
    const rolloutConfig = {
      ...config,
      rollout: {
        enabled: true,
        flagName: "w12-flag",
        metricRef: "error_rate",
        threshold: 0.1,
        pollIntervalMs: 1000,
      },
    };
    let rolledBack = false;

    const outcome = must(
      await runLineagePipeline({
        repoRoot,
        gate,
        lineage: makeLineage({
          lineageId,
          requirementId: must(RequirementId("req-w12-rollout")),
          door: classifyTwoWay(),
          acceptanceTarget: must(
            freezeAcceptanceTarget({
              targetHash: must(parseContentHash("d".repeat(64))),
              criteria: [{ id: "c1", statement: "rollout wiring" }],
              frozenAt: ts,
            }),
          ),
          declaredScope: scope,
          createdAt: ts,
        }),
        plan: planForRegime("minimal", { oracleCovered: true }),
        config: rolloutConfig,
        tasks: { implement: featureWrite("src/lib/w12-rollout.ts") },
        ids: {
          invocationBase: "inv-w12-rollout",
          transitionId: must(TransitionId("tr-w12-rollout")),
          postGateRunId: must(GateRunId("gate-w12-rollout-post")),
        },
        at: ts,
        rolloutClient: {
          arm: async () => {},
          pollMetric: async () => 0.99,
          rollback: async () => {
            rolledBack = true;
          },
        },
      }),
    );

    expect(outcome.terminal.kind).toBe("merged");
    if (outcome.terminal.kind !== "merged") return;
    expect(outcome.terminal.rollout?.kind).toBe("rolled_back");
    expect(rolledBack).toBe(true);

    const spanStore = openGateSpanStore(gateSpanDbPath(repoRoot));
    expect(must(spanStore.listByLineage(lineageId))).toHaveLength(2);
    spanStore.close();

    const escapeStore = openOracleEscapeStore(join(repoRoot, ESCAPE_DB_DIR, ESCAPE_DB_FILE));
    expect(must(escapeStore.listByLineage(lineageId))).toHaveLength(1);
    escapeStore.close();
  });

  test("decisions reject records an oracle escape by decision kind", () => {
    tmpWorkspace = mkdtempSync(join(tmpdir(), "w12-decision-reject-"));
    const dbPath = join(tmpWorkspace, DECISION_DB_DIR, DECISION_DB_FILE);
    mkdirSync(dirname(dbPath), { recursive: true });
    const store = openDecisionQueueStore(dbPath);
    const lineageId = must(LineageId("L-w12-reject"));
    must(
      store.enqueue({
        decisionId: must(DecisionId("dec-w12-reject")),
        lineageId,
        kind: "two_way_sample",
        door: classifyTwoWay(),
        enqueuedAt: ts,
      }),
    );
    store.close();

    const recorded = must(recordDecisionForLineage(tmpWorkspace, String(lineageId), "reject"));
    expect(recorded.nextState).toEqual({ status: "rejected", reason: "human_rejected" });

    const escapeStore = openOracleEscapeStore(join(tmpWorkspace, ESCAPE_DB_DIR, ESCAPE_DB_FILE));
    const escapes = must(escapeStore.listByLineage(lineageId));
    expect(escapes).toHaveLength(1);
    expect(escapes[0]?.source).toBe("sample");
    escapeStore.close();
  });
});
