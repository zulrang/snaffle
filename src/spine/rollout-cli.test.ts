import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { ESCAPE_DB_DIR, ESCAPE_DB_FILE, openOracleEscapeStore } from "../lib/oracle-escape";
import { saveLastRollout } from "../lib/rollout-store";
import { readRolloutStatus, resumeRollout } from "./rollout-cli";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W3 — rollout CLI (D8)", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("status surfaces last rollout and pending operator ack after rollback", () => {
    workspace = mkdtempSync(join(tmpdir(), "w3-rollout-"));
    const ts = must(parseTimestamp(1));
    const lineageId = must(LineageId("L-w3"));
    must(
      saveLastRollout(workspace, {
        lineageId,
        outcome: { kind: "rolled_back", metricValue: 0.9 },
        recordedAt: ts,
        operatorAcknowledged: false,
      }),
    );

    const dbPath = join(workspace, ESCAPE_DB_DIR, ESCAPE_DB_FILE);
    mkdirSync(join(workspace, ESCAPE_DB_DIR), { recursive: true });
    const store = openOracleEscapeStore(dbPath);
    must(
      store.recordEscape({
        lineageId,
        missedCriterion: "err",
        source: "metric",
        recordedAt: ts,
      }),
    );
    store.close();

    const status = must(readRolloutStatus(workspace));
    expect(status.pendingOperatorAck).toBe(true);
    expect(status.metricEscapeCount).toBe(1);
    expect(status.lastRollout?.outcome.kind).toBe("rolled_back");
  });

  test("resume acknowledges operator decision", () => {
    workspace = mkdtempSync(join(tmpdir(), "w3-resume-"));
    const ts = must(parseTimestamp(2));
    must(
      saveLastRollout(workspace, {
        lineageId: must(LineageId("L-resume")),
        outcome: { kind: "rolled_back", metricValue: 1 },
        recordedAt: ts,
        operatorAcknowledged: false,
      }),
    );
    const resumed = must(resumeRollout(workspace));
    expect(resumed.acknowledged).toBe(true);
    expect(resumed.lastRollout?.operatorAcknowledged).toBe(true);
  });
});
