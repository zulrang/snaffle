import type { DoorClassification, Regime } from "./door";
import { regimeForDoor } from "./door";
import type { LineageId, RequirementId } from "./ids";
import { scopesOverlap, type WriteScope } from "./scope";
import type { ContentHash, Result, Timestamp } from "./shared";
import { err, ok } from "./shared";

/**
 * Lineage and its frozen acceptance target (D7, D20, D25).
 *
 * A *lineage* is a single spec requirement plus the immutable acceptance target
 * it is judged against. The target's criteria are snapshotted and hashed on
 * entry; all acceptance judges that snapshot, never the live editable source, so
 * the thing being graded cannot drift out from under the grader. Lineages run
 * concurrently but are admitted only when their *declared* write scope does not
 * overlap an in-flight lineage's.
 */

// ---------------------------------------------------------------------------
// Acceptance target (frozen, hashed)
// ---------------------------------------------------------------------------

export interface AcceptanceCriterion {
  /** Stable identifier for the criterion within its target. */
  readonly id: string;
  /** The `done_when`-style assertion this criterion encodes. */
  readonly statement: string;
}

/**
 * An immutable, content-addressed snapshot of the criteria a lineage must meet.
 * The `targetHash` is computed by the snapshotter (lib/) over the criteria and
 * supplied here; the domain only guarantees the invariants (non-empty, frozen).
 */
export interface AcceptanceTarget {
  readonly targetHash: ContentHash;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly frozenAt: Timestamp;
}

export type AcceptanceTargetError =
  | { readonly kind: "no_criteria" }
  | { readonly kind: "blank_criterion"; readonly index: number }
  | { readonly kind: "duplicate_criterion_id"; readonly id: string };

export const freezeAcceptanceTarget = (input: {
  readonly targetHash: ContentHash;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly frozenAt: Timestamp;
}): Result<AcceptanceTarget, AcceptanceTargetError> => {
  if (input.criteria.length === 0) return err({ kind: "no_criteria" });

  const seen = new Set<string>();
  for (let i = 0; i < input.criteria.length; i++) {
    // Safe: index is bounded by the loop and array is non-empty here.
    const criterion = input.criteria[i] as AcceptanceCriterion;
    if (criterion.id.trim().length === 0 || criterion.statement.trim().length === 0) {
      return err({ kind: "blank_criterion", index: i });
    }
    if (seen.has(criterion.id)) {
      return err({ kind: "duplicate_criterion_id", id: criterion.id });
    }
    seen.add(criterion.id);
  }

  return ok({
    targetHash: input.targetHash,
    criteria: input.criteria,
    frozenAt: input.frozenAt,
  });
};

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export interface Lineage {
  readonly lineageId: LineageId;
  readonly requirementId: RequirementId;
  readonly door: DoorClassification;
  readonly acceptanceTarget: AcceptanceTarget;
  /** The write scope this lineage declares up front, used for admission (D20). */
  readonly declaredScope: WriteScope;
  readonly createdAt: Timestamp;
}

export const makeLineage = (input: Lineage): Lineage => input;

/** The regime is derived from the door, never stored, so it cannot disagree. */
export const lineageRegime = (lineage: Lineage): Regime => regimeForDoor(lineage.door);

/**
 * Two lineages conflict — and so cannot run concurrently — when their declared
 * write scopes overlap (D20). Non-conflicting work is never blocked.
 */
export const lineagesConflict = (a: Lineage, b: Lineage): boolean =>
  a.lineageId !== b.lineageId && scopesOverlap(a.declaredScope, b.declaredScope);
