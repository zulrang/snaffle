import {
  canStartFromPre,
  type GateCheckResult,
  type GatePhase,
  type GateReport,
} from "../domain/gate";
import type { GateRunId, LineageId } from "../domain/ids";
import { err, ok, parseTimestamp, type Result } from "../domain/shared";
import type { ProjectGateConfig } from "./gate-config";

/**
 * Deterministic gate runner (D8, D12, W5).
 *
 * PRE and POST invoke the same code path with the same configured check so the
 * self-check and authoritative gate can never disagree.
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
}

export interface GateRunnerOptions {
  readonly runCommand?: RunGateCommand;
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
  const proc = Bun.spawn([...command], {
    cwd: worktreeRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: gateRunEnv(),
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
};

const toCheckResult = (config: ProjectGateConfig, result: GateCommandResult): GateCheckResult => {
  if (result.exitCode === 0) {
    return { kind: config.checkKind, status: "passed" };
  }

  const detail = (result.stderr || result.stdout).trim().slice(0, 500);
  return {
    kind: config.checkKind,
    status: "failed",
    detail: detail.length > 0 ? detail : `exit ${result.exitCode}`,
  };
};

/** Single shared gate path for PRE and POST (D8/W5). */
export const runDeterministicGate = async (
  input: RunGateInput,
  options: GateRunnerOptions = {},
): Promise<GateReport> => {
  const runCommand = options.runCommand ?? runGateCommand;
  const commandResult = await runCommand(input.worktreeRoot, input.config.command);
  const ranAt = parseTimestamp(Date.now());
  if (!ranAt.ok) {
    throw new Error("invalid timestamp");
  }

  return {
    gateRunId: input.gateRunId,
    lineageId: input.lineageId,
    phase: input.phase,
    ranAt: ranAt.value,
    checks: [toCheckResult(input.config, commandResult)],
  };
};

export const runPreGate = async (
  input: Omit<RunGateInput, "phase">,
  options?: GateRunnerOptions,
): Promise<GateReport> => runDeterministicGate({ ...input, phase: "pre" }, options);

export const runPostGate = async (
  input: Omit<RunGateInput, "phase">,
  options?: GateRunnerOptions,
): Promise<GateReport> => runDeterministicGate({ ...input, phase: "post" }, options);

/** Refuse to start work when the PRE-gate is not green (W5). */
export const requireGreenPreGate = (report: GateReport): Result<GateReport, PreGateBlockedError> =>
  canStartFromPre(report)
    ? ok(report)
    : err({
        kind: "pre_gate_red",
        report,
      });
