import { describe, expect, test } from "bun:test";
import { LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { openOracleEscapeStore } from "../lib/oracle-escape";

/**
 * P6/S3 — oracle escape record + query. Real store is lib/oracle-escape.ts (W6).
 */

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("P6/S3 — oracle escape store", () => {
  test("record + cluster round-trip", () => {
    const store = openOracleEscapeStore(":memory:");
    const ts = must(parseTimestamp(1));
    const lineageId = must(LineageId("L-s3"));
    must(
      store.recordEscape({
        lineageId,
        missedCriterion: "c1",
        source: "hitl",
        recordedAt: ts,
      }),
    );
    expect(must(store.listByLineage(lineageId))).toHaveLength(1);
    expect(must(store.clusterByCriterion())).toHaveLength(1);
    store.close();
  });
});
