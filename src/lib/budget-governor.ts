import type { BudgetLimits } from "./orchestrator-config";

/**
 * In-memory budget circuit breaker (D22, W8).
 * Evaluated between spine steps; operator pauses survive budget auto-resume.
 */

export type PauseSource = "budget" | "operator";

export interface BudgetCounters {
  readonly rollingWindowSpent: number;
  readonly sessionSpent: number;
  readonly perChangeSpent: number;
}

export interface BudgetGovernorState {
  readonly counters: BudgetCounters;
  readonly paused: boolean;
  readonly pauseSource?: PauseSource;
}

export const createBudgetGovernor = (): BudgetGovernorState => ({
  counters: { rollingWindowSpent: 0, sessionSpent: 0, perChangeSpent: 0 },
  paused: false,
});

export type BudgetCheckResult =
  | { readonly kind: "ok" }
  | { readonly kind: "pause"; readonly source: "budget"; readonly limit: string }
  | { readonly kind: "kill"; readonly limit: string };

const overLimit = (spent: number, limit: number): boolean => spent >= limit;

/** Evaluate counters against limits — kill-switch checked first. */
export const checkBudget = (
  state: BudgetGovernorState,
  limits: BudgetLimits,
): BudgetCheckResult => {
  if (overLimit(state.counters.rollingWindowSpent, limits.killSwitchTokens)) {
    return { kind: "kill", limit: "kill_switch_tokens" };
  }
  if (overLimit(state.counters.perChangeSpent, limits.perChangeTokens)) {
    return { kind: "pause", source: "budget", limit: "per_change_tokens" };
  }
  if (overLimit(state.counters.sessionSpent, limits.sessionTokens)) {
    return { kind: "pause", source: "budget", limit: "session_tokens" };
  }
  if (overLimit(state.counters.rollingWindowSpent, limits.rollingWindowTokens)) {
    return { kind: "pause", source: "budget", limit: "rolling_window_tokens" };
  }
  return { kind: "ok" };
};

export const recordTokenSpend = (
  state: BudgetGovernorState,
  tokens: number,
): BudgetGovernorState => {
  if (tokens <= 0) return state;
  return {
    ...state,
    counters: {
      rollingWindowSpent: state.counters.rollingWindowSpent + tokens,
      sessionSpent: state.counters.sessionSpent + tokens,
      perChangeSpent: state.counters.perChangeSpent + tokens,
    },
  };
};

export const applyBudgetCheck = (
  state: BudgetGovernorState,
  limits: BudgetLimits,
): BudgetGovernorState => {
  const result = checkBudget(state, limits);
  if (result.kind === "ok") return state;
  if (state.pauseSource === "operator") return state;
  return { ...state, paused: true, pauseSource: "budget" };
};

export const pauseByOperator = (state: BudgetGovernorState): BudgetGovernorState => ({
  ...state,
  paused: true,
  pauseSource: "operator",
});

export const autoResumeBudgetPause = (state: BudgetGovernorState): BudgetGovernorState => {
  if (state.pauseSource !== "budget") return state;
  const { pauseSource: _removed, ...rest } = state;
  return { ...rest, paused: false };
};

export const resetPerChangeCounters = (state: BudgetGovernorState): BudgetGovernorState => ({
  ...state,
  counters: { ...state.counters, perChangeSpent: 0 },
});
