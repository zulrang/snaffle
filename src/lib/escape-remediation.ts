import type { AcceptanceCriterion } from "../domain/lineage";
import { type ContentHash, err, ok, type Result } from "../domain/shared";
import type { AcceptanceSnapshotRecord } from "./acceptance-snapshot";
import { hashAcceptanceCriteria } from "./acceptance-snapshot";
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
