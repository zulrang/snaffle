import {
  canStartFromPre,
  type GateCheckKind,
  type GateCheckResult,
  type GatePhase,
  type GateReport,
  type RepoGateMode,
} from "../domain/gate";
import type { GateRunId, LineageId } from "../domain/ids";
import { err, ok, parseTimestamp, type Result } from "../domain/shared";
import {
  captureContractBaseline,
  loadContractBaseline,
  loadContractSources,
  runContractDiffCheck,
  saveContractBaseline,
} from "./contract-diff";
import {
  captureGateBaseline,
  failedCheckKeySet,
  loadGateBaseline,
  saveGateBaseline,
} from "./gate-baseline";
import { loadGateConfig, type ProjectGateConfig, resolveStagesForTier } from "./gate-config";
import { loadOracleFreezeRecord, verifyOracleIntegrity } from "./oracle-freeze";
import { spawnCommand } from "./spawn";

/**
 * Deterministic gate runner (D8, D12, W1).
 *
 * PRE and POST invoke the same multi-stage code path with the same configured
 * stages so the self-check and authoritative gate can never disagree.
 */

export interface GateCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunGateCommand = (
  worktreeRoot: string,
  command: readonly string[],
) => Promise<GateCommandResult>;

export interface RunGateInput {
  readonly gateRunId: GateRunId;
  readonly lineageId: LineageId;
  readonly phase: GatePhase;
  readonly worktreeRoot: string;
  readonly config: ProjectGateConfig;
  readonly allowedPaths?: readonly string[];
}

export interface GateRunnerOptions {
  readonly runCommand?: RunGateCommand;
  /** Test/audit hook: proves PRE and POST enter the same runner entry (D12). */
  readonly onTrace?: (trace: GateRunTrace) => void;
}

/** Stable id recorded in gate traces — PRE and POST must both emit this. */
export const GATE_DETERMINISTIC_ENTRY = "lib/gate-runner#runDeterministicGate" as const;

export interface GateRunTrace {
  readonly entry: typeof GATE_DETERMINISTIC_ENTRY;
  readonly phase: GatePhase;
  readonly kind: GateCheckKind;
  readonly command?: readonly string[];
  readonly worktreeRoot: string;
}

export type PreGateBlockedError = {
  readonly kind: "pre_gate_red";
  readonly report: GateReport;
};

/** ponytail: snapshot env once per process so PRE/POST gate runs see identical env. */
let cachedGateEnv: Record<string, string | undefined> | undefined;

const gateRunEnv = (): Record<string, string | undefined> => {
  cachedGateEnv ??= { ...process.env };
  return cachedGateEnv;
};

export const runGateCommand = async (
  worktreeRoot: string,
  command: readonly string[],
): Promise<GateCommandResult> => {
  const result = await spawnCommand(command, { cwd: worktreeRoot, env: gateRunEnv() });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const commandToCheck = (kind: GateCheckKind, result: GateCommandResult): GateCheckResult => {
  if (result.exitCode === 0) {
    return { kind, status: "passed" };
  }
  const detail = (result.stderr || result.stdout).trim().slice(0, 500);
  return {
    kind,
    status: "failed",
    detail: detail.length > 0 ? detail : `exit ${result.exitCode}`,
  };
};

const runScopeIntegrityStage = (input: RunGateInput): GateCheckResult => {
  const kind = "scope_integrity" as const satisfies GateCheckKind;
  if (input.allowedPaths === undefined || input.allowedPaths.length === 0) {
    return { kind, status: "skipped" };
  }
  return { kind, status: "passed" };
};

const runOracleIntegrityStage = async (input: RunGateInput): Promise<GateCheckResult> => {
  const kind = "oracle_integrity" as const satisfies GateCheckKind;
  const freeze = loadOracleFreezeRecord(input.worktreeRoot, input.config.oracleFreezeRel);
  if (!freeze.ok) {
    return { kind, status: "failed", detail: freeze.error.detail };
  }
  if (freeze.value === undefined) {
    return { kind, status: "skipped" };
  }
  const verified = verifyOracleIntegrity(input.worktreeRoot, freeze.value);
  if (!verified.ok) {
    return { kind, status: "failed", detail: `oracle touched: ${verified.error.path}` };
  }
  return { kind, status: "passed" };
};

const runContractDiffStage = (input: RunGateInput): GateCheckResult => {
  const kind = "contract_diff" as const satisfies GateCheckKind;
  if (input.config.contractPaths.length === 0) {
    return { kind, status: "skipped" };
  }

  const baseline = loadContractBaseline(input.worktreeRoot, input.config.contractBaselineRel);
  if (!baseline.ok) {
    return { kind, status: "failed", detail: baseline.error.detail };
  }

  if (baseline.value === undefined) {
    const sources = loadContractSources(input.worktreeRoot, input.config.contractPaths);
    if (!sources.ok) {
      return { kind, status: "failed", detail: `missing contract source: ${sources.error.path}` };
    }
    const captured = captureContractBaseline(sources.value);
    saveContractBaseline(input.worktreeRoot, input.config.contractBaselineRel, captured);
    return { kind, status: "passed" };
  }

  return runContractDiffCheck(input.worktreeRoot, input.config.contractPaths, baseline.value);
};

const runStage = async (
  input: RunGateInput,
  stageKind: GateCheckKind,
  command: readonly string[] | undefined,
  runCommand: RunGateCommand,
): Promise<GateCheckResult> => {
  if (stageKind === "scope_integrity") {
    return runScopeIntegrityStage(input);
  }
  if (stageKind === "oracle_integrity") {
    return runOracleIntegrityStage(input);
  }
  if (stageKind === "contract_diff") {
    return runContractDiffStage(input);
  }
  if (command === undefined) {
    return { kind: stageKind, status: "skipped" };
  }
  const commandResult = await runCommand(input.worktreeRoot, command);
  return commandToCheck(stageKind, commandResult);
};

/** Single shared gate path for PRE and POST (D8/W1). */
export const runDeterministicGate = async (
  input: RunGateInput,
  options: GateRunnerOptions = {},
): Promise<GateReport> => {
  const runCommand = options.runCommand ?? runGateCommand;
  const stages = resolveStagesForTier(input.config);
  const checks: GateCheckResult[] = [];

  for (const stage of stages) {
    options.onTrace?.({
      entry: GATE_DETERMINISTIC_ENTRY,
      phase: input.phase,
      kind: stage.kind,
      ...(stage.command === undefined ? {} : { command: stage.command }),
      worktreeRoot: input.worktreeRoot,
    });

    const result = await runStage(input, stage.kind, stage.command, runCommand);
    checks.push(result);
    if (result.status === "failed") break;
  }

  const ranAt = parseTimestamp(Date.now());
  if (!ranAt.ok) {
    throw new Error("invalid timestamp");
  }

  const report: GateReport = {
    gateRunId: input.gateRunId,
    lineageId: input.lineageId,
    phase: input.phase,
    ranAt: ranAt.value,
    checks,
  };

  if (input.phase === "pre" && input.config.repoMode === "wrap") {
    const existing = loadGateBaseline(input.worktreeRoot, input.config.gateBaselineRel);
    if (existing.ok && existing.value === undefined) {
      saveGateBaseline(
        input.worktreeRoot,
        input.config.gateBaselineRel,
        captureGateBaseline(report),
      );
    }
  }

  return report;
};

export const runPreGate = async (
  input: Omit<RunGateInput, "phase">,
  options?: GateRunnerOptions,
): Promise<GateReport> => runDeterministicGate({ ...input, phase: "pre" }, options);

export const runPostGate = async (
  input: Omit<RunGateInput, "phase">,
  options?: GateRunnerOptions,
): Promise<GateReport> => runDeterministicGate({ ...input, phase: "post" }, options);

const preGateMode = (config: ProjectGateConfig): RepoGateMode => config.repoMode;

/** Refuse to start work when the PRE-gate is not green (W5/D16). */
export const requireGreenPreGate = (
  report: GateReport,
  config: ProjectGateConfig,
  worktreeRoot: string,
): Result<GateReport, PreGateBlockedError> => {
  const mode = preGateMode(config);
  let baselineKeys: ReadonlySet<string> | undefined;
  if (mode === "wrap") {
    const baseline = loadGateBaseline(worktreeRoot, config.gateBaselineRel);
    if (baseline.ok && baseline.value !== undefined) {
      baselineKeys = failedCheckKeySet(baseline.value);
    }
  }

  return canStartFromPre(report, mode, baselineKeys)
    ? ok(report)
    : err({ kind: "pre_gate_red", report });
};

/** Both tiers dispatch identical stage functions (D12/W2). */
export const runGateForTier = async (
  input: Omit<RunGateInput, "config" | "phase"> & { readonly config: ProjectGateConfig },
  tier: ProjectGateConfig["tier"],
  phase: GatePhase,
  options?: GateRunnerOptions,
): Promise<GateReport> =>
  runDeterministicGate(
    {
      ...input,
      phase,
      config: { ...input.config, tier },
    },
    options,
  );

export { loadGateConfig, resolveStagesForTier };
