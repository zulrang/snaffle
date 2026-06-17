import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AcceptanceCriterion,
  type AcceptanceTarget,
  type AcceptanceTargetError,
  freezeAcceptanceTarget,
} from "../domain/lineage";
import {
  type ContentHash,
  contentHashEquals,
  err,
  ok,
  parseContentHash,
  parseTimestamp,
  type Result,
  type Timestamp,
} from "../domain/shared";
import { hashCanonicalJson } from "./provenance-hash";

/**
 * Acceptance-target snapshotter (D20, W1).
 *
 * Computes `targetHash` from criteria, persists an immutable hashed snapshot
 * under `.orchestrator/`, and verifies reload integrity. Acceptance judges the
 * snapshot, not live editable source.
 */

export const ACCEPTANCE_SNAPSHOT_REL = ".orchestrator/acceptance-snapshot.json";

export interface AcceptanceSnapshotRecord {
  readonly targetHash: ContentHash;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly frozenAt: Timestamp;
}

/** Canonical content hash over sorted criteria (id + statement). */
export const hashAcceptanceCriteria = (criteria: readonly AcceptanceCriterion[]): ContentHash =>
  hashCanonicalJson(
    [...criteria]
      .map((c) => ({ id: c.id, statement: c.statement }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

/** Snapshot + freeze: callers no longer hand-supply `targetHash`. */
export const snapshotAcceptanceTarget = (input: {
  readonly criteria: readonly AcceptanceCriterion[];
  readonly frozenAt: Timestamp;
}): Result<AcceptanceTarget, AcceptanceTargetError> => {
  const targetHash = hashAcceptanceCriteria(input.criteria);
  return freezeAcceptanceTarget({
    targetHash,
    criteria: input.criteria,
    frozenAt: input.frozenAt,
  });
};

export const buildAcceptanceSnapshotRecord = (
  criteria: readonly AcceptanceCriterion[],
  frozenAt: Timestamp,
): Result<AcceptanceSnapshotRecord, AcceptanceTargetError> => {
  const target = snapshotAcceptanceTarget({ criteria, frozenAt });
  if (!target.ok) return target;
  return ok({
    targetHash: target.value.targetHash,
    criteria: target.value.criteria,
    frozenAt,
  });
};

export const saveAcceptanceSnapshot = (
  workspaceRoot: string,
  relPath: string,
  record: AcceptanceSnapshotRecord,
): Result<void, { readonly kind: "write_error"; readonly detail: string }> => {
  try {
    mkdirSync(dirname(join(workspaceRoot, relPath)), { recursive: true });
    writeFileSync(join(workspaceRoot, relPath), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return ok(undefined);
  } catch (error) {
    return err({
      kind: "write_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

export const loadAcceptanceSnapshot = (
  workspaceRoot: string,
  relPath: string,
): Result<
  AcceptanceSnapshotRecord | undefined,
  { readonly kind: "parse_error"; readonly detail: string }
> => {
  try {
    const raw = readFileSync(join(workspaceRoot, relPath), "utf8");
    const parsed = JSON.parse(raw) as {
      targetHash?: unknown;
      criteria?: unknown;
      frozenAt?: unknown;
    };
    if (typeof parsed.targetHash !== "string" || !Array.isArray(parsed.criteria)) {
      return err({ kind: "parse_error", detail: "invalid acceptance snapshot shape" });
    }
    const targetHash = parseContentHash(parsed.targetHash);
    if (!targetHash.ok) return err({ kind: "parse_error", detail: "invalid target hash" });

    const criteria: AcceptanceCriterion[] = [];
    for (const item of parsed.criteria) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { statement?: unknown }).statement === "string"
      ) {
        criteria.push({
          id: (item as { id: string }).id,
          statement: (item as { statement: string }).statement,
        });
      }
    }

    const frozenAtRaw = typeof parsed.frozenAt === "number" ? parsed.frozenAt : 0;
    const frozenAt = parseTimestamp(frozenAtRaw);
    if (!frozenAt.ok) return err({ kind: "parse_error", detail: "invalid frozenAt" });

    return ok({
      targetHash: targetHash.value,
      criteria,
      frozenAt: frozenAt.value,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ok(undefined);
    return err({
      kind: "parse_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Re-hash stored criteria and detect post-freeze drift. */
export const verifyAcceptanceSnapshotIntegrity = (
  record: AcceptanceSnapshotRecord,
): Result<void, { readonly kind: "snapshot_touched" }> => {
  const expected = hashAcceptanceCriteria(record.criteria);
  if (!contentHashEquals(expected, record.targetHash)) {
    return err({ kind: "snapshot_touched" });
  }
  return ok(undefined);
};
