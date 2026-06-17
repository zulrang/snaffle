import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { ESCAPE_DB_FILE, openOracleEscapeStore } from "./oracle-escape";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));

describe("S3/W6 — oracle escape logger (D24)", () => {
  let workspace: string;
  let store: ReturnType<typeof openOracleEscapeStore>;

  afterEach(() => {
    store?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const openStore = () => {
    workspace = mkdtempSync(join(tmpdir(), "w6-escape-"));
    store = openOracleEscapeStore(join(workspace, ESCAPE_DB_FILE));
  };

  test("recording an escape is queryable by lineage", () => {
    openStore();
    const lineageId = must(LineageId("L-escape"));
    must(
      store.recordEscape({
        lineageId,
        missedCriterion: "c1",
        source: "hitl",
        recordedAt: ts,
      }),
    );
    const listed = must(store.listByLineage(lineageId));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.missedCriterion).toBe("c1");
  });

  test("duplicate record for the same source is idempotent", () => {
    openStore();
    const lineageId = must(LineageId("L-dup"));
    must(
      store.recordEscape({
        lineageId,
        missedCriterion: "c1",
        source: "metric",
        recordedAt: ts,
      }),
    );
    must(
      store.recordEscape({
        lineageId,
        missedCriterion: "c1-updated",
        source: "metric",
        recordedAt: ts,
      }),
    );
    const listed = must(store.listByLineage(lineageId));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.missedCriterion).toBe("c1-updated");
  });

  test("cluster query groups by criterion id and returns counts", () => {
    openStore();
    must(
      store.recordEscape({
        lineageId: must(LineageId("L-a")),
        missedCriterion: "c-auth",
        source: "hitl",
        recordedAt: ts,
      }),
    );
    must(
      store.recordEscape({
        lineageId: must(LineageId("L-b")),
        missedCriterion: "c-auth",
        source: "sample",
        recordedAt: ts,
      }),
    );
    must(
      store.recordEscape({
        lineageId: must(LineageId("L-c")),
        missedCriterion: "c-perf",
        source: "metric",
        recordedAt: ts,
      }),
    );

    const clusters = must(store.clusterByCriterion());
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toEqual({
      missedCriterion: "c-auth",
      count: 2,
      lineageIds: [must(LineageId("L-a")), must(LineageId("L-b"))],
    });
  });
});
