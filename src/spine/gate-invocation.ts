import type { GateReport } from "../domain/gate";
import type { GateRunId, LineageId } from "../domain/ids";
import { err, ok, type Result } from "../domain/shared";
import { loadGateConfig, type ProjectGateConfig } from "../lib/gate-config";
import {
  type GateRunnerOptions,
  type PreGateBlockedError,
  requireGreenPreGate,
  runPostGate,
  runPreGate,
} from "../lib/gate-runner";
import { createDetachedWorktree } from "../lib/worktree";

/**
 * W5 — spine wiring for PRE/POST deterministic gate (D8).
 */

export interface WorktreeGateContext {
  readonly worktreeRoot: string;
  readonly config: ProjectGateConfig;
}

export interface PreparedWorktreeGate extends WorktreeGateContext {
  dispose(): Promise<void>;
}

export type PrepareWorktreeGateError =
  | { readonly kind: "worktree_error"; readonly detail: string }
  | { readonly kind: "gate_config_error"; readonly detail: string };

export interface GateRunIds {
  readonly gateRunId: GateRunId;
  readonly lineageId: LineageId;
}

/** Create an isolated worktree and load its project gate config. */
export const prepareWorktreeGate = async (
  repoRoot: string,
): Promise<Result<PreparedWorktreeGate, PrepareWorktreeGateError>> => {
  const worktree = await createDetachedWorktree(repoRoot);
  if (!worktree.ok) {
    return err({ kind: "worktree_error", detail: worktree.error.kind });
  }

  const config = loadGateConfig(worktree.value.root);
  if (!config.ok) {
    await worktree.value.remove();
    return err({ kind: "gate_config_error", detail: config.error.kind });
  }

  return ok({
    worktreeRoot: worktree.value.root,
    config: config.value,
    dispose: () => worktree.value.remove(),
  });
};

/** Run PRE-gate in a worktree; refuse to start when the tree is not green. */
export const runPreGateInWorktree = async (
  context: WorktreeGateContext,
  ids: GateRunIds,
  options?: GateRunnerOptions,
): Promise<Result<GateReport, PreGateBlockedError>> => {
  const report = await runPreGate(
    {
      gateRunId: ids.gateRunId,
      lineageId: ids.lineageId,
      worktreeRoot: context.worktreeRoot,
      config: context.config,
    },
    options,
  );
  return requireGreenPreGate(report, context.config, context.worktreeRoot);
};

/** Run POST-gate through the identical shared gate path. */
export const runPostGateInWorktree = async (
  context: WorktreeGateContext,
  ids: GateRunIds,
  options?: GateRunnerOptions,
): Promise<GateReport> =>
  runPostGate(
    {
      gateRunId: ids.gateRunId,
      lineageId: ids.lineageId,
      worktreeRoot: context.worktreeRoot,
      config: context.config,
    },
    options,
  );
