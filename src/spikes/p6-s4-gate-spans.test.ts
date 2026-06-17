import { describe, expect, test } from "bun:test";
import { GateRunId, LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { gateSpanPair, openGateSpanStore } from "../lib/gate-spans";

/**
 * P6/S4 — gate span promotion. Real store is lib/gate-spans.ts (W8).
 */

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("P6/S4 — gate span promotion", () => {
  test("PRE+POST pair links gateRunId and lineageId", () => {
    const store = openGateSpanStore(":memory:");
    const ts = must(parseTimestamp(1));
    const ended = must(parseTimestamp(2));
    const gateRunId = must(GateRunId("g-s4"));
    const lineageId = must(LineageId("L-s4"));

    for (const span of gateSpanPair({
      gateRunId,
      lineageId,
      at: ts,
      postOutcome: "red",
      postStageKind: "types",
      endedAt: ended,
    })) {
      must(store.recordSpan(span));
    }

    const spans = must(store.listByGateRun(gateRunId));
    expect(spans).toHaveLength(2);
    expect(spans[1]?.stageKind).toBe("types");
    store.close();
  });
});
