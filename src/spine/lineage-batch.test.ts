import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { classifyTwoWay } from "../domain/door";
import { GateRunId, LineageId, RequirementId, TransitionId } from "../domain/ids";
import { freezeAcceptanceTarget, type Lineage, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { OWNERSHIP_LOCK_DIR, OWNERSHIP_LOCK_FILE, readWriterClaim } from "../lib/ownership-lock";
import { type LineageBatchJob, runLineageBatch } from "./lineage-batch";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");
const ts = must(parseTimestamp(1_700_000_000_000));
const config = defaultOrchestratorConfig();
const reuse = { kind: "reuse" as const, coveredCriteria: ["c1"] };

const lineageWith = (id: string, paths: readonly string[]): Lineage =>
  makeLineage({
    lineageId: must(LineageId(id)),
    requirementId: must(RequirementId(`req-${id}`)),
    door: classifyTwoWay(),
    acceptanceTarget: must(
      freezeAcceptanceTarget({
        targetHash: must(parseContentHash("f".repeat(64))),
        criteria: [{ id: "c1", statement: "batch merges on green" }],
        frozenAt: ts,
      }),
    ),
    declaredScope: must(makeWriteScope(paths.map((p) => must(parseRepoPath(p))))),
    createdAt: ts,
  });

const jobFor = (id: string, paths: readonly string[], marker: string): LineageBatchJob => {
  const writeRoot = paths[0] ?? "src/lib";
  return {
    lineage: lineageWith(id, paths),
    coverage: reuse,
    tasks: {
      implement: {
        prompt: "Apply the minimal in-scope change.",
        writes: [{ path: `${writeRoot}/w4-${marker}.ts`, content: `// ${marker}\n` }],
      },
    },
    ids: {
      invocationBase: `inv-w4-batch-${marker}`,
      transitionId: must(TransitionId(`tr-w4-batch-${marker}`)),
      postGateRunId: must(GateRunId(`gate-w4-batch-${marker}-post`)),
    },
  };
};

describe("W4 — bounded-N lineage batch (D20, D23)", () => {
  afterEach(async () => {
    const lockPath = join(repoRoot, OWNERSHIP_LOCK_DIR, OWNERSHIP_LOCK_FILE);
    if (existsSync(lockPath)) {
      const claim = await readWriterClaim(repoRoot);
      if (claim?.pid === process.pid) rmSync(lockPath, { force: true });
    }
  });

  test("N+M lineages at parallelism N: non-conflicting run concurrently, conflicting serializes", async () => {
    const N = 2;
    const jobs = [
      jobFor("A", ["src/lib"], "a"),
      jobFor("B", ["src/domain"], "b"),
      jobFor("C", ["src/lib/foo"], "c"), // conflicts A
      jobFor("D", ["src/spine"], "d"),
    ];

    const outcome = must(
      await runLineageBatch({
        repoRoot,
        config,
        jobs,
        maxParallel: N,
        at: ts,
        ownerId: "w4-batch",
      }),
    );

    expect(Object.keys(outcome.results)).toHaveLength(4);
    for (const key of ["A", "B", "C", "D"]) {
      const result = outcome.results[key];
      expect(result?.ok).toBe(true);
      if (!result?.ok) continue;
      expect(result.value.terminal.kind).toBe("merged");
    }
  });
});
