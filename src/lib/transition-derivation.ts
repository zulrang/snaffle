import { type AgentResult, isScopeCompliant } from "../domain/agent";
import type { DoorClassification } from "../domain/door";
import { type GateReport, gateOutcome } from "../domain/gate";
import type { LineageId, TransitionId } from "../domain/ids";
import type { WriteScope } from "../domain/scope";
import type { Result, Timestamp } from "../domain/shared";
import { err, ok } from "../domain/shared";
import {
  deriveMergeOutcome,
  type LineageState,
  type MergeDecisionInput,
  type MergeOutcome,
  type StateTransition,
} from "../domain/transition";

/**
 * Control-plane transition derivation (D19, W6).
 *
 * The orchestrator inspects validated evidence — agent result, POST-gate, scope,
 * door — and derives the merge consequence itself. Agent results never mutate
 * authoritative state; there is no path from `AgentResult` to `merged` that
 * bypasses this module.
 */

export interface TransitionEvidence {
  readonly door: DoorClassification;
  readonly agentResult: AgentResult;
  readonly postGateReport: GateReport;
  readonly grantedScope: WriteScope;
}

export type TransitionDerivationError =
  | { readonly kind: "missing_post_gate"; readonly phase: string }
  | { readonly kind: "empty_gate_checks" };

export type ApplyTransitionResult =
  | {
      readonly kind: "transition_applied";
      readonly outcome: MergeOutcome;
      readonly transition: StateTransition;
      readonly newState: LineageState;
    }
  | {
      readonly kind: "no_transition";
      readonly outcome: MergeOutcome;
      readonly state: LineageState;
    };

export interface ApplyTransitionInput {
  readonly transitionId: TransitionId;
  readonly lineageId: LineageId;
  readonly currentState: LineageState;
  readonly evidence: TransitionEvidence;
  readonly at: Timestamp;
}

export const buildMergeDecisionInput = (evidence: TransitionEvidence): MergeDecisionInput => ({
  door: evidence.door,
  agentOutcome: evidence.agentResult.outcome,
  postGate: gateOutcome(evidence.postGateReport),
  scopeCompliant: isScopeCompliant(evidence.agentResult, evidence.grantedScope),
});

/** Derive the control-plane merge consequence from validated evidence (D19). */
export const deriveControlPlaneOutcome = (evidence: TransitionEvidence): MergeOutcome =>
  deriveMergeOutcome(buildMergeDecisionInput(evidence));

export const nextLineageState = (current: LineageState, outcome: MergeOutcome): LineageState => {
  switch (outcome.kind) {
    case "merge":
      return { status: "merged" };
    case "await_human":
      return { status: "awaiting_human" };
    case "reject":
      return { status: "rejected", reason: outcome.reason };
    case "hold":
      return current;
  }
};

export const lineageStateEquals = (a: LineageState, b: LineageState): boolean => {
  if (a.status !== b.status) return false;
  if (a.status === "running" && b.status === "running") return a.phase === b.phase;
  if (a.status === "rejected" && b.status === "rejected") return a.reason === b.reason;
  return true;
};

/** POST-gate evidence is mandatory; agent results alone cannot authorize transitions. */
export const requirePostGateEvidence = (
  evidence: TransitionEvidence,
): Result<TransitionEvidence, TransitionDerivationError> => {
  if (evidence.postGateReport.phase !== "post") {
    return err({ kind: "missing_post_gate", phase: evidence.postGateReport.phase });
  }
  if (evidence.postGateReport.checks.length === 0) {
    return err({ kind: "empty_gate_checks" });
  }
  return ok(evidence);
};

/** Apply a control-plane-derived transition; holds leave state unchanged (W6). */
export const applyControlPlaneTransition = (input: ApplyTransitionInput): ApplyTransitionResult => {
  const validated = requirePostGateEvidence(input.evidence);
  if (!validated.ok) {
    throw new Error(
      `applyControlPlaneTransition requires valid POST gate evidence: ${validated.error.kind}`,
    );
  }

  const outcome = deriveControlPlaneOutcome(input.evidence);
  const newState = nextLineageState(input.currentState, outcome);

  if (lineageStateEquals(input.currentState, newState)) {
    return { kind: "no_transition", outcome, state: input.currentState };
  }

  return {
    kind: "transition_applied",
    outcome,
    transition: {
      transitionId: input.transitionId,
      lineageId: input.lineageId,
      from: input.currentState,
      to: newState,
      at: input.at,
      basis: {
        invocationId: input.evidence.agentResult.invocationId,
        gateRunId: input.evidence.postGateReport.gateRunId,
      },
    },
    newState,
  };
};

/**
 * Derive and apply a transition from complete evidence. Incomplete evidence
 * (e.g. missing POST-gate) is rejected rather than acted on.
 */
export const reviewAndApplyTransition = (
  input: ApplyTransitionInput,
): Result<ApplyTransitionResult, TransitionDerivationError> => {
  const validated = requirePostGateEvidence(input.evidence);
  if (!validated.ok) return validated;
  return ok(applyControlPlaneTransition(input));
};
