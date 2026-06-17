import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyTwoWay } from "../domain/door";
import {
  GateRunId,
  GenerationId,
  GrantId,
  InvocationId,
  LineageId,
  RequirementId,
  TransitionId,
} from "../domain/ids";
import { freezeAcceptanceTarget, type Lineage, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { err, ok, parseContentHash, parseTimestamp, type Result } from "../domain/shared";
import { classifyDoor } from "../lib/door-classifier";
import { loadOrchestratorConfig } from "../lib/orchestrator-config";
import { type ActiveWriterClaim, attachObserver } from "../lib/ownership-lock";
import {
  type GenerationSummary,
  openProvenanceStore,
  PROVENANCE_DB_DIR,
  PROVENANCE_DB_FILE,
} from "../lib/provenance-store";
import {
  runSkeletonLineage,
  type SkeletonRunError,
  type SkeletonRunIds,
  type SkeletonRunOutcome,
  type SkeletonVariant,
} from "./skeleton-run";

/** Default walking-skeleton lineage; classifies door from repo config when repoRoot is set (W2/W9). */
export const buildDefaultPhase1Lineage = (
  repoRoot?: string,
): Result<Lineage, { readonly kind: "invalid_default" }> => {
  const ts = parseTimestamp(1_700_000_000_000);
  if (!ts.ok) return err({ kind: "invalid_default" });

  const domainPath = parseRepoPath("src/domain");
  const libPath = parseRepoPath("src/lib");
  if (!domainPath.ok || !libPath.ok) return err({ kind: "invalid_default" });

  const scope = makeWriteScope([domainPath.value, libPath.value]);
  if (!scope.ok) return err({ kind: "invalid_default" });

  const targetHash = parseContentHash("b".repeat(64));
  if (!targetHash.ok) return err({ kind: "invalid_default" });

  const acceptanceTarget = freezeAcceptanceTarget({
    targetHash: targetHash.value,
    criteria: [{ id: "c1", statement: "skeleton merges on green POST-gate" }],
    frozenAt: ts.value,
  });

  const lineageId = LineageId("lineage-phase1");
  const requirementId = RequirementId("req-phase1");
  if (!lineageId.ok || !requirementId.ok || !acceptanceTarget.ok) {
    return err({ kind: "invalid_default" });
  }

  const resolvedRoot = repoRoot === undefined ? undefined : resolve(repoRoot);
  const orchestrator = resolvedRoot === undefined ? null : loadOrchestratorConfig(resolvedRoot);
  const door = orchestrator?.ok
    ? classifyDoor(scope.value, undefined, orchestrator.value.door)
    : classifyTwoWay();

  return ok(
    makeLineage({
      lineageId: lineageId.value,
      requirementId: requirementId.value,
      door,
      acceptanceTarget: acceptanceTarget.value,
      declaredScope: scope.value,
      createdAt: ts.value,
    }),
  );
};

export const buildPhase1RunIds = (
  suffix: string,
): Result<SkeletonRunIds, { readonly kind: "invalid_id" }> => {
  const grantId = GrantId(`grant-${suffix}`);
  const invocationId = InvocationId(`inv-${suffix}`);
  const generationId = GenerationId(`gen-${suffix}`);
  const preGateRunId = GateRunId(`gate-${suffix}-pre`);
  const postGateRunId = GateRunId(`gate-${suffix}-post`);
  const transitionId = TransitionId(`tr-${suffix}`);

  if (
    !grantId.ok ||
    !invocationId.ok ||
    !generationId.ok ||
    !preGateRunId.ok ||
    !postGateRunId.ok ||
    !transitionId.ok
  ) {
    return err({ kind: "invalid_id" });
  }

  return ok({
    grantId: grantId.value,
    invocationId: invocationId.value,
    generationId: generationId.value,
    preGateRunId: preGateRunId.value,
    postGateRunId: postGateRunId.value,
    transitionId: transitionId.value,
  });
};

export interface Phase1RunInput {
  readonly repoRoot: string;
  readonly variant?: SkeletonVariant;
  readonly ownerId?: string;
  readonly runSuffix?: string;
}

export type Phase1RunError = SkeletonRunError | { readonly kind: "invalid_default" | "invalid_id" };

/** Single-shot W8 loop: lock → stub → PRE/POST gate → transition → provenance → release. */
export const runPhase1 = async (
  input: Phase1RunInput,
): Promise<Result<SkeletonRunOutcome, Phase1RunError>> => {
  const repoRoot = resolve(input.repoRoot);
  const lineage = buildDefaultPhase1Lineage(repoRoot);
  if (!lineage.ok) return err(lineage.error);

  const suffix = input.runSuffix ?? `${Date.now()}`;
  const ids = buildPhase1RunIds(suffix);
  if (!ids.ok) return err(ids.error);

  const at = parseTimestamp(Date.now());
  if (!at.ok) return err({ kind: "invalid_default" });

  return runSkeletonLineage({
    repoRoot,
    lineage: lineage.value,
    variant: input.variant ?? "merge_success",
    ids: ids.value,
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    at: at.value,
  });
};

export interface Phase1ProvenanceStatus {
  readonly exists: boolean;
  readonly dbPath: string;
  readonly recentGenerations: readonly GenerationSummary[];
}

export interface Phase1Status {
  readonly workspaceRoot: string;
  readonly writer: ActiveWriterClaim | null;
  readonly provenance: Phase1ProvenanceStatus;
}

export type Phase1StatusError =
  | { readonly kind: "invalid_workspace"; readonly detail: string }
  | { readonly kind: "provenance_error"; readonly detail: string };

/** Read-only status via D23 observer + provenance store (no writer lock taken). */
export const readPhase1Status = async (
  repoRoot: string,
  options: { readonly provenanceLimit?: number } = {},
): Promise<Result<Phase1Status, Phase1StatusError>> => {
  const workspaceRoot = resolve(repoRoot.trim());
  if (workspaceRoot.length === 0) {
    return err({ kind: "invalid_workspace", detail: "repoRoot must be non-empty" });
  }

  const observer = await attachObserver(workspaceRoot);
  if (!observer.ok) {
    return err({ kind: "invalid_workspace", detail: observer.error.kind });
  }
  observer.value.detach();

  const dbPath = join(workspaceRoot, PROVENANCE_DB_DIR, PROVENANCE_DB_FILE);
  if (!existsSync(dbPath)) {
    return ok({
      workspaceRoot,
      writer: observer.value.writer,
      provenance: { exists: false, dbPath, recentGenerations: [] },
    });
  }

  const store = openProvenanceStore(dbPath);
  const limit = options.provenanceLimit ?? 10;
  const recent = store.listRecentGenerations(limit);
  store.close();

  if (!recent.ok) {
    return err({ kind: "provenance_error", detail: recent.error.kind });
  }

  return ok({
    workspaceRoot,
    writer: observer.value.writer,
    provenance: {
      exists: true,
      dbPath,
      recentGenerations: recent.value,
    },
  });
};
