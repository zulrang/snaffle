import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateReport } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { openGateSpanStore } from "../lib/gate-spans";
import { openOracleEscapeStore } from "../lib/oracle-escape";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import {
  dryRunRolloutClient,
  escapeDbPath,
  gateSpanDbPath,
  recordGateReportSpans,
  recordOracleEscapeAtRepo,
  runPostMergeRolloutIfEnabled,
} from "./spine-wiring";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("Phase 6 spine wiring", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("recordGateReportSpans persists PRE/POST for a lineage", () => {
    workspace = mkdtempSync(join(tmpdir(), "spine-spans-"));
    const ts = must(parseTimestamp(1_700_000_000_000));
    const lineageId = must(LineageId("L-span"));
    const gateRunId = must(GateRunId("gate-span"));
    const report: GateReport = {
      gateRunId,
      lineageId,
      phase: "post",
      ranAt: ts,
      checks: [{ kind: "lint", status: "passed" }],
    };

    recordGateReportSpans(workspace, {
      gateRunId,
      lineageId,
      startedAt: ts,
      report,
    });

    const store = openGateSpanStore(gateSpanDbPath(workspace));
    expect(must(store.listByLineage(lineageId))).toHaveLength(2);
    store.close();
  });

  test("post-merge rollout records an escape on metric breach", async () => {
    workspace = mkdtempSync(join(tmpdir(), "spine-rollout-"));
    const config = {
      ...defaultOrchestratorConfig(),
      rollout: {
        enabled: true,
        flagName: "f",
        metricRef: "error_rate",
        threshold: 0.1,
        pollIntervalMs: 1000,
      },
    };
    const lineageId = must(LineageId("L-rollout"));

    const outcome = await runPostMergeRolloutIfEnabled(workspace, config, lineageId, {
      arm: async () => {},
      pollMetric: async () => 0.5,
      rollback: async () => {},
    });
    expect(outcome?.kind).toBe("rolled_back");

    const store = openOracleEscapeStore(escapeDbPath(workspace));
    expect(must(store.listByLineage(lineageId))).toHaveLength(1);
    store.close();
  });

  test("rollout disabled is a no-op", async () => {
    workspace = mkdtempSync(join(tmpdir(), "spine-no-rollout-"));
    const outcome = await runPostMergeRolloutIfEnabled(
      workspace,
      defaultOrchestratorConfig(),
      must(LineageId("L-off")),
      dryRunRolloutClient(),
    );
    expect(outcome).toBeUndefined();
  });

  test("recordOracleEscapeAtRepo is idempotent per source", () => {
    workspace = mkdtempSync(join(tmpdir(), "spine-escape-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });
    const ts = must(parseTimestamp(1));
    const lineageId = must(LineageId("L-esc"));
    recordOracleEscapeAtRepo(workspace, {
      lineageId,
      missedCriterion: "c1",
      source: "hitl",
      at: ts,
    });
    recordOracleEscapeAtRepo(workspace, {
      lineageId,
      missedCriterion: "c1-updated",
      source: "hitl",
      at: ts,
    });
    const store = openOracleEscapeStore(escapeDbPath(workspace));
    const listed = must(store.listByLineage(lineageId));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.missedCriterion).toBe("c1-updated");
    store.close();
  });
});
