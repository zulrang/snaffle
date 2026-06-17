import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BatchId, GateRunId, LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { gateSpanPair, openGateSpanStore, SPAN_DB_FILE } from "./gate-spans";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));
const ended = must(parseTimestamp(1_700_000_000_100));

describe("S4/W8 — gate span store (D10)", () => {
  let workspace: string;
  let store: ReturnType<typeof openGateSpanStore>;

  afterEach(() => {
    store?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const openStore = () => {
    workspace = mkdtempSync(join(tmpdir(), "w8-spans-"));
    store = openGateSpanStore(join(workspace, SPAN_DB_FILE));
  };

  test("PRE+POST spans link to the same gateRunId and lineageId", () => {
    openStore();
    const gateRunId = must(GateRunId("gate-run-1"));
    const lineageId = must(LineageId("L-span"));
    const batchId = must(BatchId("batch-1"));

    const pair = gateSpanPair({
      gateRunId,
      lineageId,
      batchId,
      at: ts,
      postOutcome: "green",
      endedAt: ended,
    });
    for (const span of pair) {
      must(store.recordSpan(span));
    }

    const listed = must(store.listByGateRun(gateRunId));
    expect(listed).toHaveLength(2);
    expect(listed.every((s) => s.gateRunId === gateRunId)).toBe(true);
    expect(listed.every((s) => s.lineageId === lineageId)).toBe(true);
    expect(listed.every((s) => s.batchId === batchId)).toBe(true);
    expect(listed.map((s) => s.phase)).toEqual(["pre", "post"]);
  });

  test("a red POST span names the failing stage kind", () => {
    openStore();
    const gateRunId = must(GateRunId("gate-run-red"));
    const lineageId = must(LineageId("L-red"));

    const pair = gateSpanPair({
      gateRunId,
      lineageId,
      at: ts,
      postOutcome: "red",
      postStageKind: "contract_diff",
      endedAt: ended,
    });
    for (const span of pair) {
      must(store.recordSpan(span));
    }

    const listed = must(store.listByLineage(lineageId));
    const post = listed.find((s) => s.phase === "post");
    expect(post?.outcome).toBe("red");
    expect(post?.stageKind).toBe("contract_diff");
  });
});
