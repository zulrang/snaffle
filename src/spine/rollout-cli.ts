import { join } from "node:path";
import { err, ok, type Result } from "../domain/shared";
import { ESCAPE_DB_DIR, ESCAPE_DB_FILE, openOracleEscapeStore } from "../lib/oracle-escape";
import { loadOrchestratorConfig, type RolloutConfig } from "../lib/orchestrator-config";
import {
  acknowledgeLastRollout,
  loadLastRollout,
  type RolloutLastRecord,
} from "../lib/rollout-store";

/**
 * W3 — operator ramp CLI (D8). Surfaces rollout config, last outcome, and metric escapes.
 */

export type RolloutCommand = "status" | "resume";

export type RolloutCliError =
  | { readonly kind: "config_error"; readonly detail: string }
  | { readonly kind: "store_error"; readonly detail: string };

export interface RolloutStatusOutcome {
  readonly rollout: RolloutConfig;
  readonly lastRollout?: RolloutLastRecord;
  readonly metricEscapeCount: number;
  readonly pendingOperatorAck: boolean;
}

export interface RolloutResumeOutcome {
  readonly acknowledged: boolean;
  readonly lastRollout?: RolloutLastRecord;
}

const escapeDbPath = (repoRoot: string): string => join(repoRoot, ESCAPE_DB_DIR, ESCAPE_DB_FILE);

export const readRolloutStatus = (
  repoRoot: string,
): Result<RolloutStatusOutcome, RolloutCliError> => {
  const config = loadOrchestratorConfig(repoRoot);
  if (!config.ok) return err({ kind: "config_error", detail: JSON.stringify(config.error) });

  const last = loadLastRollout(repoRoot);
  if (!last.ok) return err({ kind: "store_error", detail: JSON.stringify(last.error) });

  const store = openOracleEscapeStore(escapeDbPath(repoRoot));
  let metricEscapeCount = 0;
  try {
    const clusters = store.clusterByCriterion();
    if (!clusters.ok) return err({ kind: "store_error", detail: JSON.stringify(clusters.error) });
    for (const cluster of clusters.value) {
      for (const lineageId of cluster.lineageIds) {
        const listed = store.listByLineage(lineageId);
        if (!listed.ok) return err({ kind: "store_error", detail: JSON.stringify(listed.error) });
        metricEscapeCount += listed.value.filter((e) => e.source === "metric").length;
      }
    }
  } finally {
    store.close();
  }

  const lastRollout = last.value;
  return ok({
    rollout: config.value.rollout,
    ...(lastRollout === undefined ? {} : { lastRollout }),
    metricEscapeCount,
    pendingOperatorAck:
      lastRollout !== undefined &&
      lastRollout.outcome.kind === "rolled_back" &&
      !lastRollout.operatorAcknowledged,
  });
};

export const resumeRollout = (repoRoot: string): Result<RolloutResumeOutcome, RolloutCliError> => {
  const ack = acknowledgeLastRollout(repoRoot);
  if (!ack.ok) return err({ kind: "store_error", detail: JSON.stringify(ack.error) });
  return ok({
    acknowledged: ack.value !== undefined,
    ...(ack.value === undefined ? {} : { lastRollout: ack.value }),
  });
};
