import type { AcceptanceCriterion } from "../domain/lineage";
import {
  type ContentHash,
  contentHashEquals,
  err,
  ok,
  type Result,
  type Timestamp,
} from "../domain/shared";
import type { AcceptanceSnapshotRecord } from "./acceptance-snapshot";
import {
  ACCEPTANCE_SNAPSHOT_REL,
  buildAcceptanceSnapshotRecord,
  hashAcceptanceCriteria,
  loadAcceptanceSnapshot,
  saveAcceptanceSnapshot,
  verifyAcceptanceSnapshotIntegrity,
} from "./acceptance-snapshot";
import type { OracleEscapeCluster } from "./oracle-escape";
import { hashCanonicalJson } from "./provenance-hash";

/**
 * Escape → criteria remediation (D24, W5). Template-driven proposal from cluster +
 * frozen snapshot — no LLM; fixes land at test-author/criteria, not downstream patches.
 */

export interface RemediationProposal {
  readonly missedCriterion: string;
  readonly escapeCount: number;
  readonly proposedCriteria: readonly AcceptanceCriterion[];
  readonly testAuthorPromptDelta: string;
  readonly proposalHash: ContentHash;
}

export type RemediationError =
  | { readonly kind: "empty_cluster" }
  | { readonly kind: "missing_criterion_in_snapshot"; readonly criterionId: string };

export type ApplyRemediationError =
  | { readonly kind: "missing_snapshot"; readonly detail: string }
  | { readonly kind: "snapshot_drift"; readonly detail: string }
  | { readonly kind: "stale_proposal"; readonly detail: string }
  | { readonly kind: "no_op"; readonly detail: string }
  | { readonly kind: "write_error"; readonly detail: string };

const strengthenStatement = (statement: string, missedCriterion: string): string =>
  `${statement} (escape cluster on ${missedCriterion}: add oracle coverage for this gap)`;

/** Pure proposal from cluster + immutable snapshot; refuses empty clusters. */
export const proposeEscapeRemediation = (
  cluster: OracleEscapeCluster,
  snapshot: AcceptanceSnapshotRecord,
): Result<RemediationProposal, RemediationError> => {
  if (cluster.count <= 0 || cluster.lineageIds.length === 0) {
    return err({ kind: "empty_cluster" });
  }

  const existing = snapshot.criteria.find((c) => c.id === cluster.missedCriterion);
  const proposedCriteria: AcceptanceCriterion[] =
    existing === undefined
      ? [
          ...snapshot.criteria,
          {
            id: cluster.missedCriterion,
            statement: `Cover oracle escape cluster ${cluster.missedCriterion} with a deterministic check`,
          },
        ]
      : snapshot.criteria.map((c) =>
          c.id === cluster.missedCriterion
            ? { ...c, statement: strengthenStatement(c.statement, cluster.missedCriterion) }
            : c,
        );

  const testAuthorPromptDelta = [
    `Oracle escape cluster: ${cluster.missedCriterion} (${cluster.count} lineages).`,
    `Strengthen tests for criterion "${cluster.missedCriterion}" without weakening existing oracles.`,
    `Affected lineages: ${cluster.lineageIds.map(String).join(", ")}`,
  ].join("\n");

  const proposalHash = hashCanonicalJson({
    missedCriterion: cluster.missedCriterion,
    proposedCriteria,
    testAuthorPromptDelta,
  });

  return ok({
    missedCriterion: cluster.missedCriterion,
    escapeCount: cluster.count,
    proposedCriteria,
    testAuthorPromptDelta,
    proposalHash,
  });
};

/** Stable hash for tamper detection on persisted proposals. */
export const remediationProposalHash = (proposal: RemediationProposal): ContentHash =>
  hashCanonicalJson({
    missedCriterion: proposal.missedCriterion,
    proposedCriteria: proposal.proposedCriteria,
    testAuthorPromptDelta: proposal.testAuthorPromptDelta,
  });

/** Proposal must differ from the snapshot criteria hash (otherwise no remediation needed). */
export const proposalChangesSnapshot = (
  proposal: RemediationProposal,
  snapshot: AcceptanceSnapshotRecord,
): boolean =>
  hashAcceptanceCriteria(proposal.proposedCriteria) !== hashAcceptanceCriteria(snapshot.criteria);

/** Re-freeze acceptance snapshot from a proposal; refuses stale or drifted snapshots. */
export const applyRemediationProposal = (
  repoRoot: string,
  proposal: RemediationProposal,
  at: Timestamp,
): Result<AcceptanceSnapshotRecord, ApplyRemediationError> => {
  const loaded = loadAcceptanceSnapshot(repoRoot, ACCEPTANCE_SNAPSHOT_REL);
  if (!loaded.ok) return err({ kind: "missing_snapshot", detail: loaded.error.detail });
  if (loaded.value === undefined) {
    return err({ kind: "missing_snapshot", detail: ACCEPTANCE_SNAPSHOT_REL });
  }

  const integrity = verifyAcceptanceSnapshotIntegrity(loaded.value);
  if (!integrity.ok) return err({ kind: "snapshot_drift", detail: integrity.error.kind });

  if (!proposalChangesSnapshot(proposal, loaded.value)) {
    return err({ kind: "no_op", detail: "proposal matches current snapshot" });
  }

  const sourceHash = loaded.value.targetHash;

  const record = buildAcceptanceSnapshotRecord([...proposal.proposedCriteria], at);
  if (!record.ok) {
    return err({ kind: "write_error", detail: "invalid proposed criteria" });
  }

  const again = loadAcceptanceSnapshot(repoRoot, ACCEPTANCE_SNAPSHOT_REL);
  if (!again.ok || again.value === undefined) {
    return err({ kind: "missing_snapshot", detail: ACCEPTANCE_SNAPSHOT_REL });
  }
  if (!contentHashEquals(again.value.targetHash, sourceHash)) {
    return err({ kind: "stale_proposal", detail: "snapshot changed during apply" });
  }

  const saved = saveAcceptanceSnapshot(repoRoot, ACCEPTANCE_SNAPSHOT_REL, record.value);
  if (!saved.ok) return err({ kind: "write_error", detail: saved.error.detail });
  return ok(record.value);
};
