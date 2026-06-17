import type { DoorClassification, OneWayTrigger } from "../domain/door";
import type { RepoPath, WriteScope } from "../domain/scope";

/**
 * Stateful change detector (D9, W1). Sole entry point for expand/contract —
 * declared scope + door triggers + optional contract-surface delta.
 */

export type StatefulChangeKind = "stateful" | "non_stateful";

const STATEFUL_TRIGGERS: readonly OneWayTrigger[] = ["persisted_schema", "public_contract"];

/** ponytail: path substring heuristic; upgrade path is config-driven patterns like door-classifier. */
const STATEFUL_PATH_MARKERS = ["migration", "schema", ".sql", "persisted"] as const;

const pathLooksStateful = (path: RepoPath): boolean => {
  const lower = path.toLowerCase();
  return STATEFUL_PATH_MARKERS.some((marker) => lower.includes(marker));
};

export interface StatefulChangeInput {
  readonly scope: WriteScope;
  readonly door: DoorClassification;
  /** True when contract-diff detects a surface change vs baseline. */
  readonly contractSurfaceChanged?: boolean;
}

/** Classify whether a lineage requires expand/contract choreography (D9). */
export const detectStatefulChange = (input: StatefulChangeInput): StatefulChangeKind => {
  if (input.contractSurfaceChanged === true) return "stateful";

  if (input.door.direction === "one_way") {
    if (input.door.ambiguous === true) return "stateful";
    if (input.door.triggers.some((t) => STATEFUL_TRIGGERS.includes(t))) return "stateful";
  }

  if (input.scope.allowedPaths.some(pathLooksStateful)) return "stateful";

  return "non_stateful";
};
