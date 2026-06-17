import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LineageId } from "../domain/ids";
import {
  type ContentHash,
  contentHashEquals,
  err,
  ok,
  parseTimestamp,
  type Result,
  type Timestamp,
} from "../domain/shared";
import { hashCanonicalJson } from "./provenance-hash";
import type { StatefulChangeKind } from "./stateful-change";

/**
 * Expand/contract emitter (D9, W2). Emits an ordered multi-phase plan for
 * stateful changes; non-stateful inputs yield no plan (no-op).
 */

export const EXPAND_CONTRACT_PHASES = [
  "expand",
  "dual_write",
  "backfill",
  "flip",
  "contract",
] as const;

export type ExpandContractPhase = (typeof EXPAND_CONTRACT_PHASES)[number];

export interface ExpandContractPhaseSpec {
  readonly phase: ExpandContractPhase;
  readonly artifactPath: string;
  readonly doneWhen: string;
}

export interface ExpandContractPlan {
  readonly lineageId: LineageId;
  readonly planHash: ContentHash;
  readonly phases: readonly ExpandContractPhaseSpec[];
  readonly frozenAt: Timestamp;
}

export const EXPAND_CONTRACT_PLAN_REL = ".orchestrator/expand-contract-plan.json";

export type ExpandContractError =
  | { readonly kind: "non_stateful"; readonly detail: string }
  | { readonly kind: "invalid_phase_order"; readonly detail: string }
  | { readonly kind: "write_error"; readonly detail: string }
  | { readonly kind: "parse_error"; readonly detail: string }
  | { readonly kind: "plan_touched" };

const phaseArtifact = (lineageId: LineageId, phase: ExpandContractPhase): string =>
  `.orchestrator/expand-contract/${String(lineageId)}/${phase}.json`;

const defaultDoneWhen = (phase: ExpandContractPhase): string => {
  switch (phase) {
    case "expand":
      return "backward-compatible schema expansion is recorded and gate-green";
    case "dual_write":
      return "dual-write/read paths are recorded and gate-green";
    case "backfill":
      return "backfill job spec is recorded and gate-green";
    case "flip":
      return "read flip spec is recorded and gate-green";
    case "contract":
      return "contract/removal spec is recorded and gate-green";
  }
};

const buildPhases = (lineageId: LineageId): readonly ExpandContractPhaseSpec[] =>
  EXPAND_CONTRACT_PHASES.map((phase) => ({
    phase,
    artifactPath: phaseArtifact(lineageId, phase),
    doneWhen: defaultDoneWhen(phase),
  }));

/** Refuse plans whose phase order was tampered with. */
export const assertCanonicalPhaseOrder = (
  phases: readonly ExpandContractPhaseSpec[],
): Result<void, ExpandContractError> => {
  if (phases.length !== EXPAND_CONTRACT_PHASES.length) {
    return err({ kind: "invalid_phase_order", detail: "phase count mismatch" });
  }
  for (let i = 0; i < EXPAND_CONTRACT_PHASES.length; i++) {
    if (phases[i]?.phase !== EXPAND_CONTRACT_PHASES[i]) {
      return err({ kind: "invalid_phase_order", detail: `expected ${EXPAND_CONTRACT_PHASES[i]}` });
    }
  }
  return ok(undefined);
};

export interface EmitExpandContractInput {
  readonly lineageId: LineageId;
  readonly statefulKind: StatefulChangeKind;
  readonly frozenAt: Timestamp;
}

/** Emit a content-addressed expand/contract plan, or refuse non-stateful input. */
export const emitExpandContractPlan = (
  input: EmitExpandContractInput,
): Result<ExpandContractPlan, ExpandContractError> => {
  if (input.statefulKind !== "stateful") {
    return err({ kind: "non_stateful", detail: "no expand/contract plan for non-stateful change" });
  }

  const phases = buildPhases(input.lineageId);
  const order = assertCanonicalPhaseOrder(phases);
  if (!order.ok) return order;

  const planHash = hashCanonicalJson({
    lineageId: String(input.lineageId),
    phases: phases.map((p) => ({
      phase: p.phase,
      artifactPath: p.artifactPath,
      doneWhen: p.doneWhen,
    })),
  });

  return ok({
    lineageId: input.lineageId,
    planHash,
    phases,
    frozenAt: input.frozenAt,
  });
};

export const saveExpandContractPlan = (
  workspaceRoot: string,
  relPath: string,
  plan: ExpandContractPlan,
): Result<void, ExpandContractError> => {
  try {
    mkdirSync(dirname(join(workspaceRoot, relPath)), { recursive: true });
    writeFileSync(join(workspaceRoot, relPath), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    return ok(undefined);
  } catch (error) {
    return err({
      kind: "write_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

export const loadExpandContractPlan = (
  workspaceRoot: string,
  relPath: string,
): Result<ExpandContractPlan | undefined, ExpandContractError> => {
  try {
    const raw = readFileSync(join(workspaceRoot, relPath), "utf8");
    const parsed = JSON.parse(raw) as {
      lineageId?: unknown;
      planHash?: unknown;
      phases?: unknown;
      frozenAt?: unknown;
    };
    if (typeof parsed.lineageId !== "string" || typeof parsed.planHash !== "string") {
      return err({ kind: "parse_error", detail: "invalid plan shape" });
    }
    if (!Array.isArray(parsed.phases)) {
      return err({ kind: "parse_error", detail: "phases must be an array" });
    }

    const phases: ExpandContractPhaseSpec[] = [];
    for (const item of parsed.phases) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { phase?: unknown }).phase === "string" &&
        typeof (item as { artifactPath?: unknown }).artifactPath === "string" &&
        typeof (item as { doneWhen?: unknown }).doneWhen === "string"
      ) {
        phases.push({
          phase: (item as { phase: ExpandContractPhase }).phase,
          artifactPath: (item as { artifactPath: string }).artifactPath,
          doneWhen: (item as { doneWhen: string }).doneWhen,
        });
      }
    }

    const frozenAtRaw = typeof parsed.frozenAt === "number" ? parsed.frozenAt : 0;
    const frozenAt = parseTimestamp(frozenAtRaw);
    if (!frozenAt.ok) return err({ kind: "parse_error", detail: "invalid frozenAt" });

    const lineageId = parsed.lineageId as LineageId;
    const plan: ExpandContractPlan = {
      lineageId,
      planHash: parsed.planHash as ContentHash,
      phases,
      frozenAt: frozenAt.value,
    };

    const order = assertCanonicalPhaseOrder(phases);
    if (!order.ok) return order;

    return ok(plan);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ok(undefined);
    return err({
      kind: "parse_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Re-hash stored phases and detect post-freeze drift. */
export const verifyExpandContractPlanIntegrity = (
  plan: ExpandContractPlan,
): Result<void, ExpandContractError> => {
  const expected = hashCanonicalJson({
    lineageId: String(plan.lineageId),
    phases: plan.phases.map((p) => ({
      phase: p.phase,
      artifactPath: p.artifactPath,
      doneWhen: p.doneWhen,
    })),
  });
  if (!contentHashEquals(expected, plan.planHash)) {
    return err({ kind: "plan_touched" });
  }
  return ok(undefined);
};
