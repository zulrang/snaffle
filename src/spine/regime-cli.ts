import { classifyTwoWay } from "../domain/door";
import { GateRunId, LineageId, RequirementId, TransitionId } from "../domain/ids";
import { makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { err, ok, parseTimestamp, type Result } from "../domain/shared";
import { snapshotAcceptanceTarget } from "../lib/acceptance-snapshot";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { prepareWorktreeGate } from "./gate-invocation";
import { type LineagePipelineOutcome, runLineageForRegime } from "./phase-pipeline";

/**
 * W8 — default regime pipeline entry (replaces skeleton as the default `run`).
 */

export type RegimeRunError =
  | { readonly kind: "invalid_default" }
  | { readonly kind: "worktree_prepare"; readonly detail: string }
  | { readonly kind: "pipeline"; readonly detail: string };

export interface RegimeRunInput {
  readonly repoRoot: string;
}

export const runRegimeLineage = async (
  input: RegimeRunInput,
): Promise<Result<LineagePipelineOutcome, RegimeRunError>> => {
  const ts = parseTimestamp(Date.now());
  if (!ts.ok) return err({ kind: "invalid_default" });

  const domainPath = parseRepoPath("src/domain");
  const libPath = parseRepoPath("src/lib");
  if (!domainPath.ok || !libPath.ok) return err({ kind: "invalid_default" });

  const scope = makeWriteScope([domainPath.value, libPath.value]);
  if (!scope.ok) return err({ kind: "invalid_default" });

  const lineageId = LineageId("lineage-regime-default");
  const requirementId = RequirementId("req-regime-default");
  const transitionId = TransitionId("tr-regime-default");
  const postGateRunId = GateRunId("gate-regime-default-post");
  if (!lineageId.ok || !requirementId.ok || !transitionId.ok || !postGateRunId.ok) {
    return err({ kind: "invalid_default" });
  }

  const acceptanceTarget = snapshotAcceptanceTarget({
    criteria: [{ id: "c1", statement: "regime pipeline merges on green POST-gate" }],
    frozenAt: ts.value,
  });
  if (!acceptanceTarget.ok) return err({ kind: "invalid_default" });

  const lineage = makeLineage({
    lineageId: lineageId.value,
    requirementId: requirementId.value,
    door: classifyTwoWay(),
    acceptanceTarget: acceptanceTarget.value,
    declaredScope: scope.value,
    createdAt: ts.value,
  });

  const prepared = await prepareWorktreeGate(input.repoRoot);
  if (!prepared.ok) return err({ kind: "worktree_prepare", detail: prepared.error.kind });

  writePassingGateFixture(prepared.value.worktreeRoot);
  try {
    const outcome = await runLineageForRegime({
      repoRoot: input.repoRoot,
      gate: { worktreeRoot: prepared.value.worktreeRoot, config: skeletonGateConfig() },
      lineage,
      config: defaultOrchestratorConfig(),
      coverage: { kind: "reuse", coveredCriteria: ["c1"] },
      tasks: {
        implement: {
          prompt: "Apply a trivial in-scope marker file.",
          writes: [{ path: "src/lib/regime-marker.ts", content: "// regime default run\n" }],
        },
      },
      ids: {
        invocationBase: "inv-regime-default",
        transitionId: transitionId.value,
        postGateRunId: postGateRunId.value,
      },
      at: ts.value,
    });

    if (!outcome.ok) return err({ kind: "pipeline", detail: JSON.stringify(outcome.error) });
    return ok(outcome.value);
  } finally {
    await prepared.value.dispose();
  }
};
