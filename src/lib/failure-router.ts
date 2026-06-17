import { type FailureVerdict, routeVerdict, spendsModelBudget } from "../domain/failure";
import { escalateTier, type ModelTier } from "./tier-router";

/**
 * Failure router + bounded retry policy (D4, W4).
 * Composes classifier verdicts with retry caps and single-tier escalation.
 */

export interface RetryPolicy {
  readonly maxTransientRetries: number;
  readonly maxEscalations: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxTransientRetries: 3,
  maxEscalations: 1,
});

export interface FailureRouterState {
  readonly tier: ModelTier;
  readonly transientRetries: number;
  readonly escalations: number;
}

export const initialRouterState = (tier: ModelTier = "light"): FailureRouterState => ({
  tier,
  transientRetries: 0,
  escalations: 0,
});

export type RouteFailureDecision =
  | {
      readonly kind: "route";
      readonly action: ReturnType<typeof routeVerdict>;
      readonly tier: ModelTier;
      readonly invokeModel: boolean;
      readonly nextState: FailureRouterState;
    }
  | {
      readonly kind: "exhausted";
      readonly action: ReturnType<typeof routeVerdict>;
      readonly reason: string;
    };

export const shouldInvokeModel = (action: ReturnType<typeof routeVerdict>): boolean =>
  action === "retry_same_tier" || action === "escalate_one_tier";

/** Route a verdict with retry/escalation caps; never spend budget on non-budget categories. */
export const routeFailureWithPolicy = (
  verdict: FailureVerdict,
  state: FailureRouterState,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): RouteFailureDecision => {
  const action = routeVerdict(verdict);

  if (verdict.kind === "classified" && !spendsModelBudget(verdict.category)) {
    return {
      kind: "route",
      action,
      tier: state.tier,
      invokeModel: false,
      nextState: state,
    };
  }

  if (action === "retry_same_tier") {
    if (state.transientRetries >= policy.maxTransientRetries) {
      return {
        kind: "exhausted",
        action: "route_to_human",
        reason: "transient retry cap reached",
      };
    }
    return {
      kind: "route",
      action,
      tier: state.tier,
      invokeModel: true,
      nextState: {
        ...state,
        transientRetries: state.transientRetries + 1,
      },
    };
  }

  if (action === "escalate_one_tier") {
    if (state.escalations >= policy.maxEscalations) {
      return {
        kind: "exhausted",
        action: "route_to_human",
        reason: "model_capability escalation cap reached",
      };
    }
    const nextTier = escalateTier(state.tier);
    if (nextTier === null) {
      return {
        kind: "exhausted",
        action: "route_to_human",
        reason: "already at heavy tier",
      };
    }
    return {
      kind: "route",
      action,
      tier: nextTier,
      invokeModel: true,
      nextState: {
        tier: nextTier,
        transientRetries: state.transientRetries,
        escalations: state.escalations + 1,
      },
    };
  }

  return {
    kind: "route",
    action,
    tier: state.tier,
    invokeModel: false,
    nextState: state,
  };
};
