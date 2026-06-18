import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LineageId } from "../domain/ids";
import { err, ok, parseTimestamp, type Result, type Timestamp } from "../domain/shared";
import type { RolloutGuardrailOutcome } from "./rollout-guardrail";

/**
 * Last rollout outcome store (D8, W3). File-backed record for operator ramp CLI.
 */

export const ROLLOUT_LAST_REL = ".orchestrator/rollout-last.json";

export interface RolloutLastRecord {
  readonly lineageId: LineageId;
  readonly outcome: RolloutGuardrailOutcome;
  readonly recordedAt: Timestamp;
  readonly operatorAcknowledged: boolean;
}

export type RolloutStoreError =
  | { readonly kind: "read_error"; readonly detail: string }
  | { readonly kind: "write_error"; readonly detail: string }
  | { readonly kind: "invalid_record"; readonly detail: string };

export const saveLastRollout = (
  repoRoot: string,
  record: RolloutLastRecord,
): Result<void, RolloutStoreError> => {
  const path = join(repoRoot, ROLLOUT_LAST_REL);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return ok(undefined);
  } catch (error) {
    return err({
      kind: "write_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

export const loadLastRollout = (
  repoRoot: string,
): Result<RolloutLastRecord | undefined, RolloutStoreError> => {
  const path = join(repoRoot, ROLLOUT_LAST_REL);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as {
      lineageId?: unknown;
      outcome?: unknown;
      recordedAt?: unknown;
      operatorAcknowledged?: unknown;
    };
    if (
      typeof parsed.lineageId !== "string" ||
      typeof parsed.outcome !== "object" ||
      parsed.outcome === null ||
      typeof parsed.recordedAt !== "number"
    ) {
      return err({ kind: "invalid_record", detail: "missing lineage or outcome" });
    }
    const at = parseTimestamp(parsed.recordedAt);
    if (!at.ok) return err({ kind: "invalid_record", detail: "invalid timestamp" });
    const outcome = parsed.outcome as RolloutGuardrailOutcome;
    if (outcome.kind !== "armed" && outcome.kind !== "rolled_back" && outcome.kind !== "degraded") {
      return err({ kind: "invalid_record", detail: "invalid outcome kind" });
    }
    return ok({
      lineageId: parsed.lineageId as LineageId,
      outcome,
      recordedAt: at.value,
      operatorAcknowledged: parsed.operatorAcknowledged === true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ok(undefined);
    return err({
      kind: "read_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

export const acknowledgeLastRollout = (
  repoRoot: string,
): Result<RolloutLastRecord | undefined, RolloutStoreError> => {
  const loaded = loadLastRollout(repoRoot);
  if (!loaded.ok) return loaded;
  if (loaded.value === undefined) return ok(undefined);
  const updated: RolloutLastRecord = { ...loaded.value, operatorAcknowledged: true };
  const saved = saveLastRollout(repoRoot, updated);
  if (!saved.ok) return saved;
  return ok(updated);
};
