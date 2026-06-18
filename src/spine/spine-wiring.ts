import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type GateReport, gatePassed } from "../domain/gate";
import type { GateRunId, LineageId } from "../domain/ids";
import { parseTimestamp, type Timestamp } from "../domain/shared";
import { gateSpanPair, openGateSpanStore, SPAN_DB_DIR, SPAN_DB_FILE } from "../lib/gate-spans";
import {
  ESCAPE_DB_DIR,
  ESCAPE_DB_FILE,
  type OracleEscapeSource,
  openOracleEscapeStore,
} from "../lib/oracle-escape";
import type { OrchestratorConfig } from "../lib/orchestrator-config";
import {
  type RolloutClient,
  type RolloutGuardrailOutcome,
  runRolloutGuardrail,
} from "../lib/rollout-guardrail";

/**
 * Phase 6 spine wiring — gate spans, post-merge rollout, oracle escapes (W5/W6/W8).
 */

export const gateSpanDbPath = (repoRoot: string): string =>
  join(repoRoot, SPAN_DB_DIR, SPAN_DB_FILE);

export const escapeDbPath = (repoRoot: string): string =>
  join(repoRoot, ESCAPE_DB_DIR, ESCAPE_DB_FILE);

const ensureParent = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

/** ponytail: noop client for rollout-disabled or offline default runs. */
export const dryRunRolloutClient = (): RolloutClient => ({
  arm: async () => {},
  pollMetric: async () => 0,
  rollback: async () => {},
});

export const recordGateReportSpans = (
  repoRoot: string,
  input: {
    readonly gateRunId: GateRunId;
    readonly lineageId: LineageId;
    readonly startedAt: Timestamp;
    readonly report: GateReport;
  },
): void => {
  ensureParent(gateSpanDbPath(repoRoot));
  const store = openGateSpanStore(gateSpanDbPath(repoRoot));
  try {
    const failed = input.report.checks.find((check) => check.status === "failed");
    for (const span of gateSpanPair({
      gateRunId: input.gateRunId,
      lineageId: input.lineageId,
      at: input.startedAt,
      postOutcome: gatePassed(input.report) ? "green" : "red",
      ...(failed === undefined ? {} : { postStageKind: failed.kind }),
      endedAt: input.report.ranAt,
    })) {
      store.recordSpan(span);
    }
  } finally {
    store.close();
  }
};

export const recordOracleEscapeAtRepo = (
  repoRoot: string,
  input: {
    readonly lineageId: LineageId;
    readonly missedCriterion: string;
    readonly source: OracleEscapeSource;
    readonly at: Timestamp;
  },
): void => {
  ensureParent(escapeDbPath(repoRoot));
  const store = openOracleEscapeStore(escapeDbPath(repoRoot));
  try {
    store.recordEscape({
      lineageId: input.lineageId,
      missedCriterion: input.missedCriterion,
      source: input.source,
      recordedAt: input.at,
    });
  } finally {
    store.close();
  }
};

/** Arm flag after merge when rollout is enabled; record escape on metric rollback. */
export const runPostMergeRolloutIfEnabled = async (
  repoRoot: string,
  config: OrchestratorConfig,
  lineageId: LineageId,
  client: RolloutClient,
): Promise<RolloutGuardrailOutcome | undefined> => {
  if (!config.rollout.enabled) return undefined;

  const outcome = await runRolloutGuardrail({
    lineageId: String(lineageId),
    client,
    config: {
      flagName: config.rollout.flagName,
      metricRef: config.rollout.metricRef,
      threshold: config.rollout.threshold,
    },
  });
  if (!outcome.ok) return undefined;

  if (outcome.value.kind === "rolled_back") {
    const at = parseTimestamp(Date.now());
    if (at.ok) {
      recordOracleEscapeAtRepo(repoRoot, {
        lineageId,
        missedCriterion: config.rollout.metricRef,
        source: "metric",
        at: at.value,
      });
    }
  }
  return outcome.value;
};

export const escapeSourceForDecisionKind = (kind: string): OracleEscapeSource =>
  kind === "two_way_sample" ? "sample" : "hitl";
