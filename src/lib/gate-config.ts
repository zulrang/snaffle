import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import TOML from "smol-toml";
import type { GateCheckKind } from "../domain/gate";
import { compareCheckKind, GATE_CHECK_ORDER } from "../domain/gate";
import { err, ok, type Result } from "../domain/shared";

/**
 * Project gate configuration (D8, D18, W3).
 *
 * Stage commands are declared in `.orchestrator/gate.toml` when present; otherwise
 * the worktree's package.json `check` script maps to a single full_tests stage.
 */

export const ORCHESTRATOR_DIR = ".orchestrator";
export const DEFAULT_GATE_CONFIG_REL = ".orchestrator/gate.toml";
export const DEFAULT_GATE_BASELINE_REL = ".orchestrator/gate-baseline.json";
export const DEFAULT_CONTRACT_BASELINE_REL = ".orchestrator/contract-baseline.json";
export const DEFAULT_ORACLE_FREEZE_REL = ".orchestrator/oracle-freeze.json";

export type GateTier = "affected" | "full";
export type RepoGateMode = "strict" | "wrap" | "greenfield";

export interface GateStageDefinition {
  readonly kind: GateCheckKind;
  readonly command?: readonly string[];
  readonly skip?: boolean;
}

export interface ProjectGateConfig {
  readonly tier: GateTier;
  readonly repoMode: RepoGateMode;
  readonly stages: readonly GateStageDefinition[];
  readonly contractPaths: readonly string[];
  readonly contractBaselineRel: string;
  readonly gateBaselineRel: string;
  readonly oracleFreezeRel: string;
}

export const PHASE1_GATE_CHECK_KIND = "full_tests" as const satisfies GateCheckKind;

/** Phase 2 tiers — spec_traceability and smoke_budget deferred per cut lines. */
export const TIER_AFFECTED_KINDS: readonly GateCheckKind[] = [
  "format",
  "lint",
  "types",
  "affected_tests",
  "scope_integrity",
  "oracle_integrity",
];

export const TIER_FULL_KINDS: readonly GateCheckKind[] = [
  ...TIER_AFFECTED_KINDS,
  "full_tests",
  "contract_diff",
];

export type GateConfigError =
  | { readonly kind: "missing_package_json"; readonly worktreeRoot: string }
  | { readonly kind: "missing_check_script"; readonly worktreeRoot: string }
  | {
      readonly kind: "invalid_package_json";
      readonly worktreeRoot: string;
      readonly detail: string;
    }
  | { readonly kind: "invalid_gate_toml"; readonly detail: string }
  | { readonly kind: "unknown_stage_kind"; readonly kindName: string };

const isGateCheckKind = (value: string): value is GateCheckKind =>
  (GATE_CHECK_ORDER as readonly string[]).includes(value);

const sortStages = (stages: readonly GateStageDefinition[]): GateStageDefinition[] =>
  [...stages].sort((a, b) => compareCheckKind(a.kind, b.kind));

export const defaultPhase1GateConfig = (): ProjectGateConfig => ({
  tier: "full",
  repoMode: "strict",
  stages: [{ kind: PHASE1_GATE_CHECK_KIND, command: ["bun", "run", "check"] }],
  contractPaths: [],
  contractBaselineRel: DEFAULT_CONTRACT_BASELINE_REL,
  gateBaselineRel: DEFAULT_GATE_BASELINE_REL,
  oracleFreezeRel: DEFAULT_ORACLE_FREEZE_REL,
});

export const defaultGreenfieldGateConfigToml = (): string => `tier = "full"
repo_mode = "greenfield"

contract_paths = []

[[stages]]
kind = "full_tests"
command = ["bun", "run", "check"]
`;

export const writeDefaultPackageJson = (repoRoot: string): void => {
  writeFileSync(
    join(repoRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "greenfield-repo",
        private: true,
        scripts: { check: "exit 0" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

interface TomlStage {
  readonly kind?: unknown;
  readonly command?: unknown;
  readonly skip?: unknown;
}

const parseTomlStages = (
  rawStages: unknown,
): Result<readonly GateStageDefinition[], GateConfigError> => {
  if (!Array.isArray(rawStages)) return ok([]);
  const stages: GateStageDefinition[] = [];

  for (const item of rawStages) {
    if (typeof item !== "object" || item === null) {
      return err({ kind: "invalid_gate_toml", detail: "stage entry must be a table" });
    }
    const stage = item as TomlStage;
    if (typeof stage.kind !== "string" || !isGateCheckKind(stage.kind)) {
      return err({
        kind: "unknown_stage_kind",
        kindName: typeof stage.kind === "string" ? stage.kind : "unknown",
      });
    }

    let command: readonly string[] | undefined;
    if (stage.command !== undefined) {
      if (
        !Array.isArray(stage.command) ||
        !stage.command.every((part) => typeof part === "string")
      ) {
        return err({ kind: "invalid_gate_toml", detail: `invalid command for ${stage.kind}` });
      }
      command = stage.command as string[];
    }

    stages.push({
      kind: stage.kind,
      ...(command === undefined ? {} : { command }),
      ...(stage.skip === true ? { skip: true } : {}),
    });
  }

  return ok(sortStages(stages));
};

interface GateTomlConfig {
  readonly tier?: unknown;
  readonly repo_mode?: unknown;
  readonly stages?: unknown;
  readonly contract_paths?: unknown;
}

const parseGateToml = (raw: string): Result<ProjectGateConfig, GateConfigError> => {
  let parsed: GateTomlConfig;
  try {
    parsed = TOML.parse(raw) as GateTomlConfig;
  } catch (error) {
    return err({
      kind: "invalid_gate_toml",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const tierRaw = parsed.tier;
  const tier: GateTier = tierRaw === "affected" ? "affected" : "full";

  const repoModeRaw = parsed.repo_mode;
  const repoMode: RepoGateMode =
    repoModeRaw === "wrap" ? "wrap" : repoModeRaw === "greenfield" ? "greenfield" : "strict";

  const stagesParsed = parseTomlStages(parsed.stages);
  if (!stagesParsed.ok) return stagesParsed;

  const contractPathsRaw = parsed.contract_paths;
  const contractPaths =
    Array.isArray(contractPathsRaw) && contractPathsRaw.every((item) => typeof item === "string")
      ? (contractPathsRaw as string[])
      : [];

  return ok({
    tier,
    repoMode,
    stages: stagesParsed.value,
    contractPaths,
    contractBaselineRel: DEFAULT_CONTRACT_BASELINE_REL,
    gateBaselineRel: DEFAULT_GATE_BASELINE_REL,
    oracleFreezeRel: DEFAULT_ORACLE_FREEZE_REL,
  });
};

const loadPackageJsonFallback = (
  worktreeRoot: string,
): Result<ProjectGateConfig, GateConfigError> => {
  const packagePath = join(worktreeRoot, "package.json");
  try {
    const raw = readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: { check?: unknown } };
    if (typeof parsed.scripts?.check !== "string" || parsed.scripts.check.trim().length === 0) {
      return err({ kind: "missing_check_script", worktreeRoot });
    }
    return ok(defaultPhase1GateConfig());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return err({ kind: "missing_package_json", worktreeRoot });
    }
    return err({
      kind: "invalid_package_json",
      worktreeRoot,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Load gate config from TOML when present; otherwise package.json fallback. */
export const loadGateConfig = (
  worktreeRoot: string,
): Result<ProjectGateConfig, GateConfigError> => {
  const tomlPath = join(worktreeRoot, DEFAULT_GATE_CONFIG_REL);
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return parseGateToml(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return loadPackageJsonFallback(worktreeRoot);
    }
    return err({
      kind: "invalid_gate_toml",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Resolve active stages for a tier — same stage defs, filtered by tier kinds (D12). */
export const resolveStagesForTier = (config: ProjectGateConfig): readonly GateStageDefinition[] => {
  const allowed = new Set(config.tier === "affected" ? TIER_AFFECTED_KINDS : TIER_FULL_KINDS);
  return config.stages.filter((stage) => allowed.has(stage.kind) && stage.skip !== true);
};
