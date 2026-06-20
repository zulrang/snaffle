import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOneWay, classifyTwoWay } from "../domain/door";
import type { LineageId } from "../domain/ids";
import {
  DecisionId,
  GateRunId,
  LineageId as makeLineageId,
  RequirementId,
  TransitionId,
} from "../domain/ids";
import { makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseTimestamp } from "../domain/shared";
import {
  ACCEPTANCE_SNAPSHOT_REL,
  loadAcceptanceSnapshot,
  saveAcceptanceSnapshot,
  snapshotAcceptanceTarget,
  verifyAcceptanceSnapshotIntegrity,
} from "../lib/acceptance-snapshot";
import {
  DECISION_DB_FILE,
  type DecisionQueueStore,
  openDecisionQueueStore,
} from "../lib/decision-queue";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { OWNERSHIP_LOCK_DIR, OWNERSHIP_LOCK_FILE, readWriterClaim } from "../lib/ownership-lock";
import { loadParkedChangeArtifact } from "../lib/parked-change-store";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { shouldSampleTwoWayMerge } from "../lib/two-way-sampler";
import { type PreparedWorktreeGate, prepareWorktreeGate } from "./gate-invocation";
import { type LineageBatchJob, runLineageBatch } from "./lineage-batch";
import { type PhaseTask, runLineageForRegime } from "./phase-pipeline";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");
const ts = must(parseTimestamp(1_700_000_000_000));
const reuse = { kind: "reuse" as const, coveredCriteria: ["c1"] };
const criteria = [{ id: "c1", statement: "phase 5 integration acceptance" }] as const;

const featureWrite = (path: string): PhaseTask => ({
  prompt: "Apply the minimal in-scope change.",
  writes: [{ path, content: `// ${path}\n` }],
});

const specPlanOracleTasks = (suffix: string) => ({
  spec: {
    prompt: "Author the acceptance target.",
    writes: [{ path: `src/domain/w9-${suffix}-spec.md`, content: "# spec\n" }],
  },
  plan: {
    prompt: "Decompose into work items.",
    writes: [{ path: `src/domain/w9-${suffix}-plan.md`, content: "# plan\n" }],
  },
  oracle_authoring: {
    prompt: "Author the frozen oracle.",
    writes: [
      {
        path: `tests/w9-${suffix}.oracle.test.ts`,
        content: 'import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n',
      },
    ],
  },
});

const snapshotLineage = (
  id: string,
  paths: readonly string[],
  door: ReturnType<typeof classifyTwoWay>,
) => {
  const acceptanceTarget = must(
    snapshotAcceptanceTarget({ criteria: [...criteria], frozenAt: ts }),
  );
  must(
    saveAcceptanceSnapshot(repoRoot, ACCEPTANCE_SNAPSHOT_REL, {
      targetHash: acceptanceTarget.targetHash,
      criteria: acceptanceTarget.criteria,
      frozenAt: ts,
    }),
  );
  const loaded = must(loadAcceptanceSnapshot(repoRoot, ACCEPTANCE_SNAPSHOT_REL));
  if (loaded === undefined) throw new Error("acceptance snapshot missing after save");
  must(verifyAcceptanceSnapshotIntegrity(loaded));

  return makeLineage({
    lineageId: must(makeLineageId(id)),
    requirementId: must(RequirementId(`req-${id}`)),
    door,
    acceptanceTarget,
    declaredScope: must(makeWriteScope(paths.map((p) => must(parseRepoPath(p))))),
    createdAt: ts,
  });
};

const idsFor = (suffix: string) => ({
  invocationBase: `inv-w9-${suffix}`,
  transitionId: must(TransitionId(`tr-w9-${suffix}`)),
  postGateRunId: must(GateRunId(`gate-w9-${suffix}-post`)),
});

const findTwoWaySamplePair = (rate: number): { sampled: LineageId; unsampled: LineageId } => {
  let sampled: LineageId | undefined;
  let unsampled: LineageId | undefined;
  for (let i = 0; i < 500; i++) {
    const id = must(makeLineageId(`lineage-w9-sample-${i}`));
    if (shouldSampleTwoWayMerge(id, classifyTwoWay(), rate)) {
      sampled ??= id;
    } else {
      unsampled ??= id;
    }
    if (sampled !== undefined && unsampled !== undefined) break;
  }
  if (sampled === undefined || unsampled === undefined) {
    throw new Error("could not find sampled/unsampled lineage pair");
  }
  return { sampled, unsampled };
};

describe("W9 — spine concurrency integration (Phase 5)", () => {
  let prepared: PreparedWorktreeGate | undefined;
  let decisionWorkspace: string | undefined;
  let decisionStore: DecisionQueueStore | undefined;

  afterEach(async () => {
    decisionStore?.close();
    decisionStore = undefined;
    if (decisionWorkspace) {
      rmSync(decisionWorkspace, { recursive: true, force: true });
      decisionWorkspace = undefined;
    }
    if (prepared) {
      await prepared.dispose();
      prepared = undefined;
    }
    const lockPath = join(repoRoot, OWNERSHIP_LOCK_DIR, OWNERSHIP_LOCK_FILE);
    if (existsSync(lockPath)) {
      const claim = await readWriterClaim(repoRoot);
      if (claim?.pid === process.pid) rmSync(lockPath, { force: true });
    }
  });

  const openDecisionStore = () => {
    decisionWorkspace = mkdtempSync(join(tmpdir(), "w9-decisions-"));
    decisionStore = openDecisionQueueStore(join(decisionWorkspace, DECISION_DB_FILE));
    return decisionStore;
  };

  const prepare = async () => {
    const worktree = must(await prepareWorktreeGate(repoRoot));
    prepared = worktree;
    writePassingGateFixture(worktree.worktreeRoot);
    return { worktreeRoot: worktree.worktreeRoot, config: skeletonGateConfig() };
  };

  test("batch under one lock: non-conflicting merge in parallel, conflicting serializes (frozen snapshots)", async () => {
    const config = defaultOrchestratorConfig();
    const jobs: LineageBatchJob[] = [
      {
        lineage: snapshotLineage("w9-A", ["src/lib"], classifyTwoWay()),
        coverage: reuse,
        tasks: { implement: featureWrite("src/lib/w9-a.ts") },
        ids: idsFor("batch-a"),
      },
      {
        lineage: snapshotLineage("w9-B", ["src/domain"], classifyTwoWay()),
        coverage: reuse,
        tasks: { implement: featureWrite("src/domain/w9-b.ts") },
        ids: idsFor("batch-b"),
      },
      {
        lineage: snapshotLineage("w9-C", ["src/lib/foo"], classifyTwoWay()),
        coverage: reuse,
        tasks: { implement: featureWrite("src/lib/foo/w9-c.ts") },
        ids: idsFor("batch-c"),
      },
    ];

    const outcome = must(
      await runLineageBatch({
        repoRoot,
        config,
        jobs,
        maxParallel: 2,
        at: ts,
        ownerId: "w9-batch",
      }),
    );

    expect(Object.keys(outcome.results)).toHaveLength(3);
    for (const key of ["w9-A", "w9-B", "w9-C"]) {
      const result = outcome.results[key];
      expect(result?.ok).toBe(true);
      if (!result?.ok) continue;
      expect(result.value.terminal.kind).toBe("merged");
    }

    const snapshot = must(loadAcceptanceSnapshot(repoRoot, ACCEPTANCE_SNAPSHOT_REL));
    if (snapshot === undefined) throw new Error("acceptance snapshot missing after batch");
    must(verifyAcceptanceSnapshotIntegrity(snapshot));
  });

  test("one-way parks, enqueues, and approval only authorizes continuation", async () => {
    const store = openDecisionStore();
    const gate = await prepare();
    const lineage = snapshotLineage(
      "w9-oneway",
      ["src/domain", "src/lib"],
      must(classifyOneWay(["money"])),
    );
    const decisionId = must(DecisionId("dec-w9-oneway"));
    const suffix = "oneway";

    const outcome = must(
      await runLineageForRegime({
        repoRoot,
        gate,
        lineage,
        config: defaultOrchestratorConfig(),
        coverage: reuse,
        tasks: {
          ...specPlanOracleTasks(suffix),
          implement: featureWrite("src/lib/w9-oneway.ts"),
        },
        oraclePaths: [`tests/w9-${suffix}.oracle.test.ts`],
        ids: idsFor("oneway"),
        at: ts,
        decisionQueue: store,
        decisionId,
      }),
    );

    expect(outcome.terminal.kind).toBe("awaiting_human");
    expect(must(store.pendingCount())).toBe(1);
    const item = must(store.getByLineageId(lineage.lineageId));
    expect(item?.kind).toBe("merge_hold");
    expect(item?.parkedChangeHash).toMatch(/^[0-9a-f]{64}$/);
    if (item?.parkedChangeHash === undefined) throw new Error("missing parked change hash");
    const artifact = must(loadParkedChangeArtifact(gate.worktreeRoot, item.parkedChangeHash));
    expect(artifact.writes.map((write) => write.path)).toEqual([
      `tests/w9-${suffix}.oracle.test.ts`,
      "src/lib/w9-oneway.ts",
    ]);

    const approved = must(
      store.recordDecision({
        decisionId,
        decision: "approve",
        currentState: { status: "awaiting_human" },
        decidedAt: ts,
      }),
    );
    expect(approved.nextState).toEqual({ status: "approved_for_merge" });
    expect(approved.item.approvedChangeHash).toBe(item?.parkedChangeHash);
    expect(must(store.pendingCount())).toBe(0);
  });

  test("sampled two-way parks in the queue; unsampled two-way auto-merges", async () => {
    const store = openDecisionStore();
    const gate = await prepare();
    const rate = 0.5;
    const config = { ...defaultOrchestratorConfig(), hitl: { twoWaySampleRate: rate } };
    const { sampled, unsampled } = findTwoWaySamplePair(rate);

    const unsampledOutcome = must(
      await runLineageForRegime({
        repoRoot,
        gate,
        lineage: snapshotLineage(String(unsampled), ["src/lib"], classifyTwoWay()),
        config,
        coverage: reuse,
        tasks: { implement: featureWrite("src/lib/w9-unsampled.ts") },
        ids: idsFor("unsampled"),
        at: ts,
        decisionQueue: store,
        decisionId: must(DecisionId("dec-w9-unsampled")),
      }),
    );
    expect(unsampledOutcome.terminal.kind).toBe("merged");
    expect(must(store.getByLineageId(unsampled))).toBeUndefined();

    const gate2 = await prepare();
    const sampledOutcome = must(
      await runLineageForRegime({
        repoRoot,
        gate: gate2,
        lineage: snapshotLineage(String(sampled), ["src/domain"], classifyTwoWay()),
        config,
        coverage: reuse,
        tasks: { implement: featureWrite("src/domain/w9-sampled.ts") },
        ids: idsFor("sampled"),
        at: ts,
        decisionQueue: store,
        decisionId: must(DecisionId("dec-w9-sampled")),
        decisionReview: {
          summary: "Sampled docs review context",
          scope: ["src/domain"],
          acceptanceCriteria: ["phase 5 integration acceptance"],
        },
      }),
    );
    expect(sampledOutcome.terminal.kind).toBe("awaiting_human");
    const sampledItem = must(store.getByLineageId(sampled));
    expect(sampledItem?.kind).toBe("two_way_sample");
    expect(sampledItem?.parkedChangeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sampledItem?.review).toEqual({
      summary: "Sampled docs review context",
      scope: ["src/domain"],
      acceptanceCriteria: ["phase 5 integration acceptance"],
      changedPaths: ["src/domain/w9-sampled.ts"],
      writePreviews: [
        {
          path: "src/domain/w9-sampled.ts",
          content: "// src/domain/w9-sampled.ts\n",
        },
      ],
    });
    expect(must(store.pendingCount())).toBe(1);
  });
});
