import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyOneWay } from "../domain/door";
import { GateRunId, LineageId, RequirementId, TransitionId } from "../domain/ids";
import { freezeAcceptanceTarget, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import { gateSpanPair, openGateSpanStore, SPAN_DB_DIR, SPAN_DB_FILE } from "../lib/gate-spans";
import { ESCAPE_DB_DIR, ESCAPE_DB_FILE, openOracleEscapeStore } from "../lib/oracle-escape";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { type RolloutClient, runRolloutGuardrail } from "../lib/rollout-guardrail";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { reportEscapeClusters } from "./escapes-cli";
import { type PreparedWorktreeGate, prepareWorktreeGate } from "./gate-invocation";
import { runLineageForRegime } from "./phase-pipeline";

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
});
