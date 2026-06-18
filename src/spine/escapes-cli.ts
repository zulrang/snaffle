import { join } from "node:path";
import { err, ok, parseTimestamp, type Result } from "../domain/shared";
import {
  ACCEPTANCE_SNAPSHOT_REL,
  type AcceptanceSnapshotRecord,
  loadAcceptanceSnapshot,
  verifyAcceptanceSnapshotIntegrity,
} from "../lib/acceptance-snapshot";
import type { RemediationProposal } from "../lib/escape-remediation";
import { applyRemediationProposal, proposeEscapeRemediation } from "../lib/escape-remediation";
import {
  ESCAPE_DB_DIR,
  ESCAPE_DB_FILE,
  type OracleEscapeCluster,
  type OracleEscapeRecord,
  openOracleEscapeStore,
} from "../lib/oracle-escape";

/**
 * W7 — oracle escape cluster report CLI (D24).
 */

export type EscapesCommand = "list" | "report" | "propose" | "apply-criteria";

export interface EscapesProposeOutcome {
  readonly proposals: readonly RemediationProposal[];
}

export type EscapesCliError =
  | { readonly kind: "store_error"; readonly detail: string }
  | { readonly kind: "missing_snapshot"; readonly detail: string }
  | { readonly kind: "snapshot_drift"; readonly detail: string }
  | { readonly kind: "missing_criterion"; readonly detail: string }
  | { readonly kind: "cluster_not_found"; readonly criterionId: string }
  | { readonly kind: "stale_proposal"; readonly detail: string }
  | { readonly kind: "no_op"; readonly detail: string }
  | { readonly kind: "write_error"; readonly detail: string }
  | { readonly kind: "invalid_timestamp"; readonly detail: string };

export interface EscapesApplyOutcome {
  readonly snapshot: AcceptanceSnapshotRecord;
  readonly proposal: RemediationProposal;
}

export interface EscapesListOutcome {
  readonly escapes: readonly OracleEscapeRecord[];
}

export interface EscapesReportOutcome {
  readonly clusters: readonly OracleEscapeCluster[];
}

const escapeDbPath = (repoRoot: string): string => join(repoRoot, ESCAPE_DB_DIR, ESCAPE_DB_FILE);

const openStore = (repoRoot: string) => openOracleEscapeStore(escapeDbPath(repoRoot));

export const listEscapes = (repoRoot: string): Result<EscapesListOutcome, EscapesCliError> => {
  const store = openStore(repoRoot);
  try {
    const clusters = store.clusterByCriterion();
    if (!clusters.ok) return err({ kind: "store_error", detail: JSON.stringify(clusters.error) });
    const escapes: OracleEscapeRecord[] = [];
    for (const cluster of clusters.value) {
      for (const lineageId of cluster.lineageIds) {
        const listed = store.listByLineage(lineageId);
        if (!listed.ok) return err({ kind: "store_error", detail: JSON.stringify(listed.error) });
        escapes.push(...listed.value);
      }
    }
    return ok({ escapes });
  } finally {
    store.close();
  }
};

export const reportEscapeClusters = (
  repoRoot: string,
): Result<EscapesReportOutcome, EscapesCliError> => {
  const store = openStore(repoRoot);
  try {
    const clusters = store.clusterByCriterion();
    if (!clusters.ok) return err({ kind: "store_error", detail: JSON.stringify(clusters.error) });
    return ok({ clusters: clusters.value });
  } finally {
    store.close();
  }
};

export const proposeEscapeRemediations = (
  repoRoot: string,
  missedCriterion?: string,
): Result<EscapesProposeOutcome, EscapesCliError> => {
  const loaded = loadAcceptanceSnapshot(repoRoot, ACCEPTANCE_SNAPSHOT_REL);
  if (!loaded.ok) return err({ kind: "missing_snapshot", detail: loaded.error.detail });
  if (loaded.value === undefined) {
    return err({ kind: "missing_snapshot", detail: ACCEPTANCE_SNAPSHOT_REL });
  }
  const integrity = verifyAcceptanceSnapshotIntegrity(loaded.value);
  if (!integrity.ok) {
    return err({ kind: "snapshot_drift", detail: integrity.error.kind });
  }

  const clusters = reportEscapeClusters(repoRoot);
  if (!clusters.ok) return clusters;

  const selected: OracleEscapeCluster[] =
    missedCriterion === undefined
      ? [...clusters.value.clusters]
      : clusters.value.clusters.filter((c) => c.missedCriterion === missedCriterion);

  const proposals: RemediationProposal[] = [];
  for (const cluster of selected) {
    const proposal = proposeEscapeRemediation(cluster, loaded.value);
    if (proposal.ok) proposals.push(proposal.value);
  }
  return ok({ proposals });
};

export const applyEscapeCriteriaAtRepo = (
  repoRoot: string,
  missedCriterion: string,
): Result<EscapesApplyOutcome, EscapesCliError> => {
  if (missedCriterion.length === 0) {
    return err({ kind: "missing_criterion", detail: "criterion id required" });
  }

  const at = parseTimestamp(Date.now());
  if (!at.ok) return err({ kind: "invalid_timestamp", detail: "invalid timestamp" });

  const loaded = loadAcceptanceSnapshot(repoRoot, ACCEPTANCE_SNAPSHOT_REL);
  if (!loaded.ok) return err({ kind: "missing_snapshot", detail: loaded.error.detail });
  if (loaded.value === undefined) {
    return err({ kind: "missing_snapshot", detail: ACCEPTANCE_SNAPSHOT_REL });
  }
  const integrity = verifyAcceptanceSnapshotIntegrity(loaded.value);
  if (!integrity.ok) return err({ kind: "snapshot_drift", detail: integrity.error.kind });

  const clusters = reportEscapeClusters(repoRoot);
  if (!clusters.ok) return err({ kind: "store_error", detail: JSON.stringify(clusters.error) });

  const cluster = clusters.value.clusters.find((c) => c.missedCriterion === missedCriterion);
  if (cluster === undefined) {
    return err({ kind: "cluster_not_found", criterionId: missedCriterion });
  }

  const proposal = proposeEscapeRemediation(cluster, loaded.value);
  if (!proposal.ok) {
    return err({ kind: "cluster_not_found", criterionId: missedCriterion });
  }

  const applied = applyRemediationProposal(repoRoot, proposal.value, at.value);
  if (!applied.ok) return err(applied.error);

  return ok({ snapshot: applied.value, proposal: proposal.value });
};
