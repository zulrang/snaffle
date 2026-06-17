import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentHash } from "../domain/shared";
import { contentHashEquals, err, ok, type Result } from "../domain/shared";
import { DEFAULT_GATE_CONFIG_REL, ORCHESTRATOR_DIR } from "./gate-config";
import {
  defaultOrchestratorConfig,
  type OrchestratorConfig,
  parseOrchestratorToml,
} from "./orchestrator-config";
import { hashCanonicalJson } from "./provenance-hash";

/**
 * Execution plan compiler + freezer (D21, S3/W5).
 * Config inputs are compiled to a content-addressed plan; drift after freeze is refused.
 */

export const FROZEN_PLAN_REL = ".orchestrator/frozen-plan.json";

export interface PlanSources {
  readonly gateTomlRaw: string;
  readonly orchestrator: OrchestratorConfig;
}

export interface FrozenExecutionPlan {
  readonly planHash: ContentHash;
  readonly frozenAt: number;
  readonly sources: PlanSources;
}

export type PlanFreezeError =
  | { readonly kind: "invalid_gate_toml"; readonly detail: string }
  | { readonly kind: "io_error"; readonly detail: string };

export type PlanFreshnessError = {
  readonly kind: "stale_plan";
  readonly storedHash: ContentHash;
  readonly liveHash: ContentHash;
};

const canonicalPlanMaterial = (sources: PlanSources): unknown => ({
  gateTomlRaw: sources.gateTomlRaw,
  orchestrator: sources.orchestrator,
});

export const computeExecutionPlanHash = (sources: PlanSources): ContentHash =>
  hashCanonicalJson(canonicalPlanMaterial(sources));

/** Compile gate + orchestrator config into a frozen execution plan. */
export const compileExecutionPlan = (sources: PlanSources): FrozenExecutionPlan => ({
  planHash: computeExecutionPlanHash(sources),
  frozenAt: Date.now(),
  sources,
});

export const assertPlanFresh = (
  frozen: FrozenExecutionPlan,
  live: PlanSources,
): Result<void, PlanFreshnessError> => {
  const liveHash = computeExecutionPlanHash(live);
  if (!contentHashEquals(frozen.planHash, liveHash)) {
    return err({ kind: "stale_plan", storedHash: frozen.planHash, liveHash });
  }
  return ok(undefined);
};

export const loadPlanSources = (worktreeRoot: string): Result<PlanSources, PlanFreezeError> => {
  const tomlPath = join(worktreeRoot, DEFAULT_GATE_CONFIG_REL);
  try {
    const gateTomlRaw = readFileSync(tomlPath, "utf8");
    const orchestrator = parseOrchestratorToml(gateTomlRaw);
    if (!orchestrator.ok) {
      return err({
        kind: "invalid_gate_toml",
        detail:
          orchestrator.error.kind === "invalid_gate_toml"
            ? orchestrator.error.detail
            : orchestrator.error.kind,
      });
    }
    return ok({ gateTomlRaw, orchestrator: orchestrator.value });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return ok({ gateTomlRaw: "", orchestrator: defaultOrchestratorConfig() });
    }
    return err({
      kind: "io_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

export const saveFrozenPlan = (
  worktreeRoot: string,
  plan: FrozenExecutionPlan,
): Result<string, PlanFreezeError> => {
  const dir = join(worktreeRoot, ORCHESTRATOR_DIR);
  const path = join(worktreeRoot, FROZEN_PLAN_REL);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    return ok(path);
  } catch (error) {
    return err({
      kind: "io_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

export const loadFrozenPlan = (
  worktreeRoot: string,
): Result<FrozenExecutionPlan | null, PlanFreezeError> => {
  const path = join(worktreeRoot, FROZEN_PLAN_REL);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as FrozenExecutionPlan;
    return ok(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ok(null);
    return err({
      kind: "io_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Alias for inspection/rollback of the last-good plan on disk. */
export const loadLastGoodPlan = loadFrozenPlan;

export const freezePlanAt = (
  worktreeRoot: string,
): Result<FrozenExecutionPlan, PlanFreezeError> => {
  const sources = loadPlanSources(worktreeRoot);
  if (!sources.ok) return sources;
  const plan = compileExecutionPlan(sources.value);
  const saved = saveFrozenPlan(worktreeRoot, plan);
  if (!saved.ok) return saved;
  return ok(plan);
};
