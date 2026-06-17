import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHashEquals } from "../domain/shared";
import { DEFAULT_GATE_CONFIG_REL } from "./gate-config";
import {
  assertPlanFresh,
  compileExecutionPlan,
  computeExecutionPlanHash,
  FROZEN_PLAN_REL,
  freezePlanAt,
  loadPlanSources,
} from "./plan-freezer";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("S3/W5 — execution plan compile + drift (D21)", () => {
  test("plan hash recomputes from stored inputs", () => {
    const sources = must(loadPlanSources("/nonexistent-use-defaults"));
    const plan = compileExecutionPlan(sources);
    expect(contentHashEquals(plan.planHash, computeExecutionPlanHash(sources))).toBe(true);
  });

  test("mutating gate.toml after freeze yields stale-plan error", () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-plan-"));
    mkdirSync(join(root, ".orchestrator"), { recursive: true });
    writeFileSync(join(root, DEFAULT_GATE_CONFIG_REL), 'tier = "full"\n');

    const frozen = must(freezePlanAt(root));
    writeFileSync(join(root, DEFAULT_GATE_CONFIG_REL), 'tier = "affected"\n');

    const live = must(loadPlanSources(root));
    const fresh = assertPlanFresh(frozen, live);
    expect(fresh.ok).toBe(false);
    if (fresh.ok) return;
    expect(fresh.error.kind).toBe("stale_plan");

    rmSync(root, { recursive: true, force: true });
  });

  test("last-good plan is queryable on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-plan2-"));
    mkdirSync(join(root, ".orchestrator"), { recursive: true });
    writeFileSync(join(root, DEFAULT_GATE_CONFIG_REL), '[door]\nauth = ["**/auth/**"]\n');

    const frozen = must(freezePlanAt(root));
    const onDisk = JSON.parse(readFileSync(join(root, FROZEN_PLAN_REL), "utf8"));
    expect(onDisk.planHash).toBe(frozen.planHash);

    rmSync(root, { recursive: true, force: true });
  });
});
