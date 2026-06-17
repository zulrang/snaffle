import type { Lineage } from "../domain/lineage";
import { admitCandidate } from "./conflict-admission";

/**
 * Bounded-N admission planning (W4, D20). Pure scheduling over declared-scope
 * conflict admission — picks the next lineages that may start given in-flight
 * work and a parallelism ceiling. Execution (worktrees, lock) lives in spine/.
 */

export interface AdmissionPlan {
  readonly admit: readonly Lineage[];
  readonly defer: readonly Lineage[];
}

/** Pick lineages that may start now without exceeding `maxParallel` or scope conflicts. */
export const planNextAdmissions = (
  pending: readonly Lineage[],
  inFlight: readonly Lineage[],
  maxParallel: number,
): AdmissionPlan => {
  const slots = Math.max(0, maxParallel - inFlight.length);
  if (slots === 0) return { admit: [], defer: pending };

  const admit: Lineage[] = [];
  const defer: Lineage[] = [];
  const running = [...inFlight];

  for (const candidate of pending) {
    if (admit.length >= slots) {
      defer.push(candidate);
      continue;
    }
    const decision = admitCandidate(candidate, running);
    if (decision.kind === "admitted") {
      admit.push(candidate);
      running.push(candidate);
    } else {
      defer.push(candidate);
    }
  }

  return { admit, defer };
};

/** True when every pending lineage has been admitted (batch complete). */
export const batchComplete = (pending: readonly Lineage[], inFlight: readonly Lineage[]): boolean =>
  pending.length === 0 && inFlight.length === 0;
