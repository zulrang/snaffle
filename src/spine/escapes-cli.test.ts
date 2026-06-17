import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { ESCAPE_DB_DIR, ESCAPE_DB_FILE, openOracleEscapeStore } from "../lib/oracle-escape";
import { listEscapes, reportEscapeClusters } from "./escapes-cli";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const escapeDbPath = (workspace: string): string => join(workspace, ESCAPE_DB_DIR, ESCAPE_DB_FILE);

describe("W7 — escapes CLI (D24)", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("report groups clusters; empty store is not an error", () => {
    workspace = mkdtempSync(join(tmpdir(), "w7-escapes-"));
    const report = must(reportEscapeClusters(workspace));
    expect(report.clusters).toEqual([]);

    const dbPath = escapeDbPath(workspace);
    mkdirSync(dirname(dbPath), { recursive: true });
    const store = openOracleEscapeStore(dbPath);
    const ts = must(parseTimestamp(1));
    must(
      store.recordEscape({
        lineageId: must(LineageId("L-esc")),
        missedCriterion: "c1",
        source: "metric",
        recordedAt: ts,
      }),
    );
    store.close();

    const again = must(reportEscapeClusters(workspace));
    expect(again.clusters).toHaveLength(1);
    expect(again.clusters[0]?.lineageIds.map(String)).toContain("L-esc");
  });

  test("list returns recorded escapes", () => {
    workspace = mkdtempSync(join(tmpdir(), "w7-escapes-list-"));
    const dbPath = escapeDbPath(workspace);
    mkdirSync(dirname(dbPath), { recursive: true });
    const store = openOracleEscapeStore(dbPath);
    const ts = must(parseTimestamp(1));
    must(
      store.recordEscape({
        lineageId: must(LineageId("L-list")),
        missedCriterion: "c2",
        source: "hitl",
        recordedAt: ts,
      }),
    );
    store.close();

    const listed = must(listEscapes(workspace));
    expect(listed.escapes.length).toBeGreaterThan(0);
  });
});
