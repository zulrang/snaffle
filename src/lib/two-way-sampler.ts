import type { DoorClassification } from "../domain/door";
import type { LineageId } from "../domain/ids";
import type { OrchestratorConfig } from "./orchestrator-config";
import { hashUtf8 } from "./provenance-hash";

/**
 * Risk-weighted two-way sampling (D11, W6). A deterministic, config-driven
 * fraction of two-way merges are enqueued for human review; unsampled two-way
 * auto-merges. One-way doors always park via requiresHumanSignOff — never here.
 */

/** Map lineage id to a stable unit bucket in [0, 1). */
export const sampleBucketForLineage = (lineageId: LineageId): number => {
  const hash = String(hashUtf8(String(lineageId)));
  const slice = hash.slice(0, 8);
  const parsed = Number.parseInt(slice, 16);
  if (!Number.isFinite(parsed)) return 0;
  return parsed / 0xffff_ffff;
};

/** True when a two-way merge should park for human sampling at this rate (0..1). */
export const shouldSampleTwoWayMerge = (
  lineageId: LineageId,
  door: DoorClassification,
  sampleRate: number,
): boolean => {
  if (door.direction !== "two_way") return false;
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return sampleBucketForLineage(lineageId) < sampleRate;
};

export const twoWaySampleRateFromConfig = (config: OrchestratorConfig): number =>
  config.hitl.twoWaySampleRate;
