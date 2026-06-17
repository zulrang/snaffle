import { describe, expect, test } from "bun:test";
import { classifyOneWay, classifyTwoWay } from "../domain/door";
import { LineageId } from "../domain/ids";
import { defaultOrchestratorConfig } from "./orchestrator-config";
import {
  sampleBucketForLineage,
  shouldSampleTwoWayMerge,
  twoWaySampleRateFromConfig,
} from "./two-way-sampler";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W6 — risk-weighted two-way sampling (D11)", () => {
  test("selection is deterministic for a fixed lineage id", () => {
    const id = must(LineageId("lineage-w6-fixed"));
    expect(sampleBucketForLineage(id)).toBe(sampleBucketForLineage(id));
    expect(shouldSampleTwoWayMerge(id, classifyTwoWay(), 0.5)).toBe(
      shouldSampleTwoWayMerge(id, classifyTwoWay(), 0.5),
    );
  });

  test("sample rate 0 never samples; rate 1 always samples two-way", () => {
    const id = must(LineageId("lineage-w6-rate"));
    expect(shouldSampleTwoWayMerge(id, classifyTwoWay(), 0)).toBe(false);
    expect(shouldSampleTwoWayMerge(id, classifyTwoWay(), 1)).toBe(true);
  });

  test("one-way doors are never sampled by this path (they always park separately)", () => {
    const id = must(LineageId("lineage-w6-oneway"));
    expect(shouldSampleTwoWayMerge(id, must(classifyOneWay(["money"])), 1)).toBe(false);
  });

  test("sample rate is read from orchestrator config", () => {
    const config = { ...defaultOrchestratorConfig(), hitl: { twoWaySampleRate: 0.25 } };
    expect(twoWaySampleRateFromConfig(config)).toBe(0.25);
  });
});
