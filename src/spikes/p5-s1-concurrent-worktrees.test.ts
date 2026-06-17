import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gatePassed } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import {
  acquireWriterLock,
  OWNERSHIP_LOCK_DIR,
  OWNERSHIP_LOCK_FILE,
  readWriterClaim,
  type WriterLock,
} from "../lib/ownership-lock";
import {
  skeletonGateConfig,
  writeFailingGateFixture,
  writePassingGateFixture,
} from "../lib/skeleton-gate-fixture";
import {
  type PreparedWorktreeGate,
  prepareWorktreeGate,
  runPostGateInWorktree,
} from "../spine/gate-invocation";

/**
 * P5/S1 — bounded-N concurrent worktrees under one writer lock.
 *
 * Retires the concurrency-mechanics risk: do N isolated detached worktrees run
 * independent gate subprocesses correctly in parallel beneath a single held
 * lock, and does a second writer still fail fast? Throwaway spike code.
 */

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");
const N = 3;

describe("P5/S1 — concurrent worktrees under one lock", () => {
  let lock: WriterLock | undefined;
  const prepared: PreparedWorktreeGate[] = [];

  afterEach(async () => {
    await Promise.all(prepared.map((p) => p.dispose().catch(() => undefined)));
    prepared.length = 0;
    if (lock) {
      await lock.release();
      lock = undefined;
    }
    const lockPath = join(repoRoot, OWNERSHIP_LOCK_DIR, OWNERSHIP_LOCK_FILE);
    if (existsSync(lockPath)) {
      const claim = await readWriterClaim(repoRoot);
      if (claim?.pid === process.pid) rmSync(lockPath, { force: true });
    }
  });

  test("N worktrees run independent gates in parallel; one red does not taint the greens", async () => {
    lock = must(await acquireWriterLock({ workspaceRoot: repoRoot, ownerId: "p5-s1" }));

    // Worktree creation is serialized (git locks $GIT_DIR/worktrees); gate
    // execution then runs concurrently.
    for (let i = 0; i < N; i += 1) {
      prepared.push(must(await prepareWorktreeGate(repoRoot)));
    }
    expect(new Set(prepared.map((p) => p.worktreeRoot)).size).toBe(N);

    // Fixture i=0 fails, the rest pass — proves per-worktree isolation.
    prepared.forEach((p, i) => {
      if (i === 0) writeFailingGateFixture(p.worktreeRoot);
      else writePassingGateFixture(p.worktreeRoot);
    });

    const reports = await Promise.all(
      prepared.map((p, i) =>
        runPostGateInWorktree(
          { worktreeRoot: p.worktreeRoot, config: skeletonGateConfig() },
          {
            gateRunId: must(GateRunId(`gate-p5-s1-${i}`)),
            lineageId: must(LineageId(`lineage-p5-s1-${i}`)),
          },
        ),
      ),
    );

    expect(gatePassed(reports[0] as (typeof reports)[number])).toBe(false);
    for (let i = 1; i < N; i += 1) {
      expect(gatePassed(reports[i] as (typeof reports)[number])).toBe(true);
    }
  });

  test("a second writer fails fast while the lock is held", async () => {
    lock = must(await acquireWriterLock({ workspaceRoot: repoRoot, ownerId: "p5-s1-holder" }));

    const second = await acquireWriterLock({ workspaceRoot: repoRoot, ownerId: "p5-s1-intruder" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe("workspace_already_owned");
  });
});
