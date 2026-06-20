import { join } from "node:path";
import { type GateReport, gatePassed } from "../domain/gate";
import { GateRunId, LineageId, TransitionId } from "../domain/ids";
import { err, ok, parseTimestamp, type Result } from "../domain/shared";
import type { StateTransition } from "../domain/transition";
import {
  DECISION_DB_DIR,
  DECISION_DB_FILE,
  type DecisionItem,
  openDecisionQueueStore,
} from "../lib/decision-queue";
import { createGhPrClient, defaultGhExec } from "../lib/gh-pr-adapter";
import { acquireWriterLock } from "../lib/ownership-lock";
import { loadParkedChangeArtifact, type ParkedChangeArtifact } from "../lib/parked-change-store";
import {
  enqueuePrFailure,
  type PrClient,
  type PrSource,
  type PublishPrResult,
  publishPr,
} from "../lib/pr-adapter";
import { type SpawnResult, spawnCommand } from "../lib/spawn";
import { createDetachedWorktree } from "../lib/worktree";
import { applyWritesToWorktree } from "../lib/worktree-writes";
import { runPostGateInWorktree } from "./gate-invocation";

export interface VcsContinuation {
  commitAndPush(input: {
    readonly repoRoot: string;
    readonly lineageId: LineageId;
    readonly writes: ParkedChangeArtifact["writes"];
  }): Promise<Result<VcsContinuationOutcome, VcsContinuationError>>;
}

export type VcsContinuationOutcome =
  | { readonly kind: "committed_and_pushed" }
  | { readonly kind: "already_applied" }
  | {
      readonly kind: "would_commit_and_push";
      readonly paths: readonly string[];
    };

export type VcsContinuationError = { readonly kind: "vcs_error"; readonly detail: string };

export type ResumeLineageError =
  | { readonly kind: "invalid_lineage"; readonly detail: string }
  | { readonly kind: "not_found"; readonly lineageId: string }
  | { readonly kind: "not_approved"; readonly lineageId: string }
  | { readonly kind: "queue_error"; readonly detail: string }
  | { readonly kind: "workspace_lock"; readonly detail: string }
  | { readonly kind: "worktree_apply"; readonly detail: string };

export type ResumeLineageOutcome =
  | {
      readonly kind: "merged";
      readonly transition: StateTransition;
      readonly postGate: GateReport;
      readonly artifactHash: string;
      readonly vcs: VcsContinuationOutcome;
      readonly pr?: PublishPrResult;
    }
  | {
      readonly kind: "validated_no_push";
      readonly postGate: GateReport;
      readonly artifactHash: string;
      readonly vcs: VcsContinuationOutcome;
    }
  | {
      readonly kind: "reparked";
      readonly reason: "stale_approval" | "missing_artifact" | "post_gate_red" | "merge_failed";
      readonly item: DecisionItem;
    };

const decisionDbPath = (repoRoot: string): string =>
  join(repoRoot, DECISION_DB_DIR, DECISION_DB_FILE);

const shellDetail = (result: SpawnResult): string =>
  (result.stderr || result.stdout || `exit ${result.exitCode}`).trim();

const defaultVcsContinuation: VcsContinuation = {
  async commitAndPush(input) {
    const paths = input.writes.map((write) => write.path);
    if (paths.length === 0) return ok({ kind: "already_applied" });

    const add = await spawnCommand(["git", "add", "--", ...paths], { cwd: input.repoRoot });
    if (add.exitCode !== 0) return err({ kind: "vcs_error", detail: shellDetail(add) });

    const diff = await spawnCommand(["git", "diff", "--cached", "--quiet", "--", ...paths], {
      cwd: input.repoRoot,
    });
    if (diff.exitCode === 0) return ok({ kind: "already_applied" });
    if (diff.exitCode !== 1) return err({ kind: "vcs_error", detail: shellDetail(diff) });

    const commit = await spawnCommand(
      ["git", "commit", "-m", `snaffle: resume ${input.lineageId}`],
      { cwd: input.repoRoot },
    );
    if (commit.exitCode !== 0) return err({ kind: "vcs_error", detail: shellDetail(commit) });

    const push = await spawnCommand(["git", "push"], { cwd: input.repoRoot });
    if (push.exitCode !== 0) return err({ kind: "vcs_error", detail: shellDetail(push) });

    return ok({ kind: "committed_and_pushed" });
  },
};

const noPushVcsContinuation: VcsContinuation = {
  async commitAndPush(input) {
    const paths = input.writes.map((write) => write.path);
    if (paths.length === 0) return ok({ kind: "already_applied" });
    return ok({ kind: "would_commit_and_push", paths });
  },
};

const prSourceFor = (
  lineageId: LineageId,
  item: DecisionItem,
  artifact: ParkedChangeArtifact,
): PrSource => ({
  lineageId: String(lineageId),
  summary: item.review?.summary ?? `Resume ${lineageId}`,
  regime: artifact.plan.regime,
  planHash: String(artifact.artifactHash),
  contextHash: String(artifact.artifactHash),
  generationId: `gen-${lineageId}`,
});

const publishResumePr = async (input: {
  readonly repoRoot: string;
  readonly lineageId: LineageId;
  readonly item: DecisionItem;
  readonly artifact: ParkedChangeArtifact;
  readonly client: PrClient;
}): Promise<
  Result<PublishPrResult | undefined, { readonly kind: "queue_error"; readonly detail: string }>
> => {
  const source = prSourceFor(input.lineageId, input.item, input.artifact);
  const published = await publishPr(source, input.client);
  if (!published.ok) return ok(undefined);
  if (published.value.kind === "degraded_to_queue") {
    const queued = enqueuePrFailure(input.repoRoot, source, published.value, Date.now());
    if (!queued.ok) {
      return err({ kind: "queue_error", detail: JSON.stringify(queued.error) });
    }
  }
  return ok(published.value);
};

export const resumeApprovedLineage = async (
  repoRoot: string,
  rawLineageId: string,
  options: {
    readonly vcs?: VcsContinuation;
    readonly noPush?: boolean;
    readonly publishPr?: boolean;
    readonly prClient?: PrClient;
  } = {},
): Promise<Result<ResumeLineageOutcome, ResumeLineageError>> => {
  const lineageId = LineageId(rawLineageId);
  if (!lineageId.ok) return err({ kind: "invalid_lineage", detail: rawLineageId });

  const store = openDecisionQueueStore(decisionDbPath(repoRoot));
  try {
    const item = store.getByLineageId(lineageId.value);
    if (!item.ok) return err({ kind: "queue_error", detail: JSON.stringify(item.error) });
    if (item.value === undefined) return err({ kind: "not_found", lineageId: rawLineageId });
    if (
      (item.value.decision !== "approve" && item.value.decision !== "override") ||
      item.value.approvedChangeHash === undefined
    ) {
      return err({ kind: "not_approved", lineageId: rawLineageId });
    }
    if (
      item.value.parkedChangeHash === undefined ||
      item.value.approvedChangeHash === undefined ||
      item.value.parkedChangeHash !== item.value.approvedChangeHash
    ) {
      const reparked = store.repark({ decisionId: item.value.decisionId });
      if (!reparked.ok) return err({ kind: "queue_error", detail: JSON.stringify(reparked.error) });
      return ok({ kind: "reparked", reason: "stale_approval", item: reparked.value });
    }

    const artifact = loadParkedChangeArtifact(repoRoot, item.value.approvedChangeHash);
    if (!artifact.ok) {
      const reparked = store.repark({ decisionId: item.value.decisionId });
      if (!reparked.ok) return err({ kind: "queue_error", detail: JSON.stringify(reparked.error) });
      return ok({ kind: "reparked", reason: "missing_artifact", item: reparked.value });
    }

    const locked = await acquireWriterLock({ workspaceRoot: repoRoot });
    if (!locked.ok) return err({ kind: "workspace_lock", detail: locked.error.kind });
    try {
      const continuationWorktree = await createDetachedWorktree(repoRoot);
      if (!continuationWorktree.ok) {
        const reparked = store.repark({ decisionId: item.value.decisionId });
        if (!reparked.ok) {
          return err({ kind: "queue_error", detail: JSON.stringify(reparked.error) });
        }
        return ok({ kind: "reparked", reason: "merge_failed", item: reparked.value });
      }

      try {
        const applied = applyWritesToWorktree(
          continuationWorktree.value.root,
          artifact.value.writes,
        );
        if (!applied.ok) {
          const reparked = store.repark({ decisionId: item.value.decisionId });
          if (!reparked.ok) {
            return err({ kind: "queue_error", detail: JSON.stringify(reparked.error) });
          }
          return ok({ kind: "reparked", reason: "merge_failed", item: reparked.value });
        }

        const at = parseTimestamp(Date.now());
        if (!at.ok) return err({ kind: "queue_error", detail: "invalid timestamp" });
        const suffix = `${lineageId.value}-${at.value}`;
        const gateRunId = GateRunId(`gate-resume-${suffix}-post`);
        const transitionId = TransitionId(`tr-resume-${suffix}`);
        if (!gateRunId.ok || !transitionId.ok) {
          return err({ kind: "queue_error", detail: "invalid resume ids" });
        }

        const postGate = await runPostGateInWorktree(
          { worktreeRoot: continuationWorktree.value.root, config: artifact.value.gateConfig },
          { gateRunId: gateRunId.value, lineageId: lineageId.value },
        );
        if (!gatePassed(postGate)) {
          const reparked = store.repark({ decisionId: item.value.decisionId });
          if (!reparked.ok) {
            return err({ kind: "queue_error", detail: JSON.stringify(reparked.error) });
          }
          return ok({ kind: "reparked", reason: "post_gate_red", item: reparked.value });
        }

        if (options.noPush === true) {
          const vcs = await (options.vcs ?? noPushVcsContinuation).commitAndPush({
            repoRoot,
            lineageId: lineageId.value,
            writes: artifact.value.writes,
          });
          if (!vcs.ok) {
            const reparked = store.repark({ decisionId: item.value.decisionId });
            if (!reparked.ok) {
              return err({ kind: "queue_error", detail: JSON.stringify(reparked.error) });
            }
            return ok({ kind: "reparked", reason: "merge_failed", item: reparked.value });
          }
          return ok({
            kind: "validated_no_push",
            postGate,
            artifactHash: String(artifact.value.artifactHash),
            vcs: vcs.value,
          });
        }

        const appliedToRepo = applyWritesToWorktree(repoRoot, artifact.value.writes);
        if (!appliedToRepo.ok) {
          const reparked = store.repark({ decisionId: item.value.decisionId });
          if (!reparked.ok) {
            return err({ kind: "queue_error", detail: JSON.stringify(reparked.error) });
          }
          return ok({ kind: "reparked", reason: "merge_failed", item: reparked.value });
        }

        const vcs = await (options.vcs ?? defaultVcsContinuation).commitAndPush({
          repoRoot,
          lineageId: lineageId.value,
          writes: artifact.value.writes,
        });
        if (!vcs.ok) {
          const reparked = store.repark({ decisionId: item.value.decisionId });
          if (!reparked.ok) {
            return err({ kind: "queue_error", detail: JSON.stringify(reparked.error) });
          }
          return ok({ kind: "reparked", reason: "merge_failed", item: reparked.value });
        }

        const pr =
          options.publishPr === true
            ? await publishResumePr({
                repoRoot,
                lineageId: lineageId.value,
                item: item.value,
                artifact: artifact.value,
                client: options.prClient ?? createGhPrClient(defaultGhExec(repoRoot)),
              })
            : ok(undefined);
        if (!pr.ok) return err({ kind: "queue_error", detail: JSON.stringify(pr.error) });

        const transition: StateTransition = {
          transitionId: transitionId.value,
          lineageId: lineageId.value,
          from: { status: "approved_for_merge" },
          to: { status: "merged" },
          at: at.value,
          basis: { gateRunId: gateRunId.value },
        };

        return ok({
          kind: "merged",
          transition,
          postGate,
          artifactHash: String(artifact.value.artifactHash),
          vcs: vcs.value,
          ...(pr.value === undefined ? {} : { pr: pr.value }),
        });
      } finally {
        await continuationWorktree.value.remove();
      }
    } finally {
      await locked.value.release();
    }
  } finally {
    store.close();
  }
};
