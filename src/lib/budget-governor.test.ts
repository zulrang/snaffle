import { describe, expect, test } from "bun:test";
import {
  applyBudgetCheck,
  autoResumeBudgetPause,
  checkBudget,
  createBudgetGovernor,
  pauseByOperator,
  recordTokenSpend,
} from "./budget-governor";
import { defaultOrchestratorConfig } from "./orchestrator-config";

describe("W8 — budget circuit breaker (D22)", () => {
  const limits = defaultOrchestratorConfig().budget;

  test("exceeding per-change limit pauses the lineage", () => {
    let state = createBudgetGovernor();
    state = recordTokenSpend(state, limits.perChangeTokens);
    const check = checkBudget(state, limits);
    expect(check.kind).toBe("pause");
    state = applyBudgetCheck(state, limits);
    expect(state.paused).toBe(true);
    expect(state.pauseSource).toBe("budget");
  });

  test("operator pause survives budget auto-resume", () => {
    let state = pauseByOperator(createBudgetGovernor());
    state = autoResumeBudgetPause(state);
    expect(state.paused).toBe(true);
    expect(state.pauseSource).toBe("operator");
  });

  test("runaway spend hits kill-switch", () => {
    let state = createBudgetGovernor();
    state = recordTokenSpend(state, limits.killSwitchTokens);
    expect(checkBudget(state, limits).kind).toBe("kill");
  });
});
