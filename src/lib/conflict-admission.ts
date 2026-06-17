import type { LineageId } from "../domain/ids";
import { type Lineage, lineagesConflict } from "../domain/lineage";

/**
 * Conflict admission (D20, W3). The sole admission entry point for the scheduler:
 * a candidate is admitted unless its declared scope conflicts with an in-flight
 * lineage, in which case it is back-pressured behind the deterministically first
 * conflictor (by lineage id). Non-conflicting work is never blocked.
 */

export type AdmissionDecision =
  | { readonly kind: "admitted" }
  | { readonly kind: "back_pressured"; readonly behind: LineageId };

/** Admit a candidate against in-flight lineages using declared-scope overlap (D20). */
export const admitCandidate = (
  candidate: Lineage,
  inFlight: readonly Lineage[],
): AdmissionDecision => {
  const conflictors = inFlight
    .filter((lineage) => lineagesConflict(candidate, lineage))
    .map((lineage) => lineage.lineageId)
    .sort((a, b) => String(a).localeCompare(String(b)));

  const first = conflictors[0];
  return first === undefined ? { kind: "admitted" } : { kind: "back_pressured", behind: first };
};

/** True when every in-flight lineage that blocked the candidate has completed. */
export const conflictorsCleared = (candidate: Lineage, inFlight: readonly Lineage[]): boolean =>
  admitCandidate(candidate, inFlight).kind === "admitted";
