import type { TransitionId } from "../domain/ids";
import type { Lineage } from "../domain/lineage";
import type { Result, Timestamp } from "../domain/shared";
import type { LineageState } from "../domain/transition";
import {
  type ApplyTransitionInput,
  type ApplyTransitionResult,
  applyControlPlaneTransition,
  reviewAndApplyTransition,
  type TransitionDerivationError,
  type TransitionEvidence,
} from "../lib/transition-derivation";

/**
 * W6 — spine wiring for control-plane transition derivation (D19).
 *
 * State changes flow only through validated evidence reviewed by the control
 * plane. Agent results are inputs to that review, never transition commands.
 */

export interface LineageTransitionReview {
  readonly lineage: Lineage;
  readonly currentState: LineageState;
  readonly evidence: TransitionEvidence;
  readonly transitionId: TransitionId;
  readonly at: Timestamp;
}

const toApplyInput = (review: LineageTransitionReview): ApplyTransitionInput => ({
  transitionId: review.transitionId,
  lineageId: review.lineage.lineageId,
  currentState: review.currentState,
  evidence: {
    door: review.lineage.door,
    agentResult: review.evidence.agentResult,
    postGateReport: review.evidence.postGateReport,
    grantedScope: review.evidence.grantedScope,
  },
  at: review.at,
});

/** Review validated evidence and apply the consequent control-plane transition. */
export const reviewLineageTransition = (
  review: LineageTransitionReview,
): Result<ApplyTransitionResult, TransitionDerivationError> =>
  reviewAndApplyTransition(toApplyInput(review));

export { type ApplyTransitionResult, applyControlPlaneTransition, type TransitionEvidence };
