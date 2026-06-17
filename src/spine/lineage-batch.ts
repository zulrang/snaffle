import type { DecisionId } from "../domain/ids";
import type { Lineage } from "../domain/lineage";
import { err, ok, type Result, type Timestamp } from "../domain/shared";
import type { DecisionQueueStore } from "../lib/decision-queue";
import { planNextAdmissions } from "../lib/lineage-scheduler";
import type { OracleCoverageDecision } from "../lib/oracle-coverage";
import type { OrchestratorConfig } from "../lib/orchestrator-config";
import { acquireWriterLock, type WriterLock } from "../lib/ownership-lock";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { prepareWorktreeGate } from "./gate-invocation";
import {
  type LineagePipelineOutcome,
  type PhaseTask,
  type PipelineError,
  type PipelineIds,
  runLineageForRegime,
} from "./phase-pipeline";

/**
 * W4 — bounded-N lineage batch runner (D20, D23). Holds the writer lock once,
 * admits lineages via conflict-aware planning, creates worktrees serially (S1),
 * and runs pipelines concurrently up to `maxParallel`.
 */

export interface LineageBatchJob {
  readonly lineage: Lineage;
  readonly coverage: OracleCoverageDecision;
  readonly tasks: Partial<Record<import("../lib/regime-plan").PipelinePhase, PhaseTask>>;
  readonly ids: PipelineIds;
  readonly decisionId?: DecisionId;
}

export interface LineageBatchInput {
  readonly repoRoot: string;
  readonly config: OrchestratorConfig;
  readonly jobs: readonly LineageBatchJob[];
  readonly maxParallel: number;
  readonly at: Timestamp;
  readonly ownerId?: string;
  readonly decisionQueue?: DecisionQueueStore;
}

export type LineageBatchResult = Result<LineagePipelineOutcome, PipelineError>;

export interface LineageBatchOutcome {
  readonly results: Readonly<Record<string, LineageBatchResult>>;
}

export type LineageBatchError =
  | { readonly kind: "workspace_lock"; readonly detail: string }
  | { readonly kind: "worktree_prepare"; readonly detail: string }
  | { readonly kind: "scheduler_stuck"; readonly detail: string };

const lineageKey = (lineage: Lineage): string => String(lineage.lineageId);

const runOneJob = async (
  repoRoot: string,
  config: OrchestratorConfig,
  job: LineageBatchJob,
  at: Timestamp,
  decisionQueue?: DecisionQueueStore,
): Promise<LineageBatchResult> => {
  const prepared = await prepareWorktreeGate(repoRoot);
  if (!prepared.ok) {
    return err({ kind: "worktree_apply", detail: prepared.error.kind });
  }

  writePassingGateFixture(prepared.value.worktreeRoot);
  try {
    return runLineageForRegime({
      repoRoot,
      gate: { worktreeRoot: prepared.value.worktreeRoot, config: skeletonGateConfig() },
      lineage: job.lineage,
      config,
      coverage: job.coverage,
      tasks: job.tasks,
      ids: job.ids,
      at,
      ...(decisionQueue === undefined ? {} : { decisionQueue }),
      ...(job.decisionId === undefined ? {} : { decisionId: job.decisionId }),
    });
  } finally {
    await prepared.value.dispose();
  }
};

/** Run a batch of lineages with bounded parallelism under one writer lock. */
export const runLineageBatch = async (
  input: LineageBatchInput,
): Promise<Result<LineageBatchOutcome, LineageBatchError>> => {
  let lock: WriterLock | undefined;
  try {
    const locked = await acquireWriterLock(
      input.ownerId === undefined
        ? { workspaceRoot: input.repoRoot }
        : { workspaceRoot: input.repoRoot, ownerId: input.ownerId },
    );
    if (!locked.ok) {
      return err({ kind: "workspace_lock", detail: locked.error.kind });
    }
    lock = locked.value;

    let pending = [...input.jobs];
    const inFlight = new Map<
      string,
      { readonly lineage: Lineage; readonly promise: Promise<LineageBatchResult> }
    >();
    const results: Record<string, LineageBatchResult> = {};

    while (pending.length > 0 || inFlight.size > 0) {
      const inFlightLineages = [...inFlight.values()].map((entry) => entry.lineage);
      const plan = planNextAdmissions(
        pending.map((job) => job.lineage),
        inFlightLineages,
        input.maxParallel,
      );

      const admitKeys = new Set(plan.admit.map((l) => lineageKey(l)));
      const toStart = pending.filter((job) => admitKeys.has(lineageKey(job.lineage)));
      pending = pending.filter((job) => !admitKeys.has(lineageKey(job.lineage)));

      for (const job of toStart) {
        const key = lineageKey(job.lineage);
        const promise = runOneJob(
          input.repoRoot,
          input.config,
          job,
          input.at,
          input.decisionQueue,
        ).then((result) => {
          results[key] = result;
          inFlight.delete(key);
          return result;
        });
        inFlight.set(key, { lineage: job.lineage, promise });
      }

      if (toStart.length === 0) {
        if (inFlight.size === 0 && pending.length > 0) {
          return err({ kind: "scheduler_stuck", detail: "conflict deadlock" });
        }
        if (inFlight.size > 0) {
          await Promise.race([...inFlight.values()].map((entry) => entry.promise));
        }
      }
    }

    return ok({ results });
  } finally {
    if (lock) await lock.release();
  }
};
