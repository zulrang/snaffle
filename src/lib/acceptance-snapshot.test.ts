import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTimestamp } from "../domain/shared";
import {
  ACCEPTANCE_SNAPSHOT_REL,
  buildAcceptanceSnapshotRecord,
  hashAcceptanceCriteria,
  loadAcceptanceSnapshot,
  saveAcceptanceSnapshot,
  snapshotAcceptanceTarget,
  verifyAcceptanceSnapshotIntegrity,
} from "./acceptance-snapshot";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));
const criteriaA = [{ id: "c1", statement: "merges on green POST-gate" }];
const criteriaB = [{ id: "c1", statement: "different criterion" }];

describe("W1 — acceptance-target snapshotter (D20)", () => {
  let workspace: string;
  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("identical criteria hash identically; differing criteria diverge", () => {
    const a = hashAcceptanceCriteria(criteriaA);
    const b = hashAcceptanceCriteria(criteriaA);
    const c = hashAcceptanceCriteria(criteriaB);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("snapshotAcceptanceTarget computes the hash — callers no longer hand-supply it", () => {
    const target = must(snapshotAcceptanceTarget({ criteria: criteriaA, frozenAt: ts }));
    expect(String(target.targetHash)).toBe(String(hashAcceptanceCriteria(criteriaA)));
    expect(target.criteria).toEqual(criteriaA);
  });

  test("the snapshot is retained on disk and reloadable", () => {
    workspace = mkdtempSync(join(tmpdir(), "w1-snap-"));
    const record = must(buildAcceptanceSnapshotRecord(criteriaA, ts));
    must(saveAcceptanceSnapshot(workspace, ACCEPTANCE_SNAPSHOT_REL, record));

    const loaded = must(loadAcceptanceSnapshot(workspace, ACCEPTANCE_SNAPSHOT_REL));
    expect(loaded).toBeDefined();
    expect(loaded?.criteria).toEqual(criteriaA);
    expect(String(loaded?.targetHash)).toBe(String(record.targetHash));
  });

  test("tampering with the snapshot is detected as drift", () => {
    workspace = mkdtempSync(join(tmpdir(), "w1-drift-"));
    const record = must(buildAcceptanceSnapshotRecord(criteriaA, ts));
    must(saveAcceptanceSnapshot(workspace, ACCEPTANCE_SNAPSHOT_REL, record));

    const path = join(workspace, ACCEPTANCE_SNAPSHOT_REL);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { criteria: unknown[] };
    raw.criteria = [{ id: "c1", statement: "quietly weakened" }];
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const loaded = must(loadAcceptanceSnapshot(workspace, ACCEPTANCE_SNAPSHOT_REL));
    if (loaded === undefined) throw new Error("expected snapshot");
    expect(verifyAcceptanceSnapshotIntegrity(loaded).ok).toBe(false);
  });
});
