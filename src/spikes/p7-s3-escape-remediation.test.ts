import { describe, expect, test } from "bun:test";
import { LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { buildAcceptanceSnapshotRecord } from "../lib/acceptance-snapshot";
import { proposeEscapeRemediation } from "../lib/escape-remediation";

/**
 * P7/S3 — escape → criteria remediation hook.
 */

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("P7/S3 — escape remediation hook", () => {
  test("fixture cluster produces stable proposal hash", () => {
    const ts = must(parseTimestamp(1));
    const snapshot = must(buildAcceptanceSnapshotRecord([{ id: "c1", statement: "check" }], ts));
    const cluster = {
      missedCriterion: "c1",
      count: 1,
      lineageIds: [must(LineageId("L1"))],
    };
    const a = must(proposeEscapeRemediation(cluster, snapshot));
    const b = must(proposeEscapeRemediation(cluster, snapshot));
    expect(a.proposalHash).toBe(b.proposalHash);
  });
});
