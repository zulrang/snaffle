import { describe, expect, test } from "bun:test";
import { LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { buildAcceptanceSnapshotRecord } from "./acceptance-snapshot";
import {
  proposalChangesSnapshot,
  proposeEscapeRemediation,
  remediationProposalHash,
} from "./escape-remediation";
import type { OracleEscapeCluster } from "./oracle-escape";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W5 — escape remediation emitter (D24)", () => {
  const ts = must(parseTimestamp(1_700_000_000_000));
  const snapshot = must(
    buildAcceptanceSnapshotRecord(
      [
        { id: "c1", statement: "Original criterion" },
        { id: "c2", statement: "Another check" },
      ],
      ts,
    ),
  );

  test("identical inputs produce stable proposal hash", () => {
    const cluster: OracleEscapeCluster = {
      missedCriterion: "c1",
      count: 2,
      lineageIds: [must(LineageId("L1")), must(LineageId("L2"))],
    };
    const a = must(proposeEscapeRemediation(cluster, snapshot));
    const b = must(proposeEscapeRemediation(cluster, snapshot));
    expect(a.proposalHash).toBe(b.proposalHash);
    expect(remediationProposalHash(a)).toBe(a.proposalHash);
  });

  test("strengthens an existing criterion statement", () => {
    const cluster: OracleEscapeCluster = {
      missedCriterion: "c1",
      count: 1,
      lineageIds: [must(LineageId("L1"))],
    };
    const proposal = must(proposeEscapeRemediation(cluster, snapshot));
    expect(proposal.proposedCriteria.find((c) => c.id === "c1")?.statement).toContain(
      "escape cluster",
    );
    expect(proposalChangesSnapshot(proposal, snapshot)).toBe(true);
  });

  test("adds a criterion when cluster id is absent from snapshot", () => {
    const cluster: OracleEscapeCluster = {
      missedCriterion: "new-gap",
      count: 1,
      lineageIds: [must(LineageId("L9"))],
    };
    const proposal = must(proposeEscapeRemediation(cluster, snapshot));
    expect(proposal.proposedCriteria.some((c) => c.id === "new-gap")).toBe(true);
  });

  test("refuses empty cluster", () => {
    const result = proposeEscapeRemediation(
      { missedCriterion: "c1", count: 0, lineageIds: [] },
      snapshot,
    );
    expect(result.ok).toBe(false);
  });
});
