import { describe, expect, test } from "bun:test";
import { routeVerdict } from "../domain/failure";
import {
  DEFAULT_RETRY_POLICY,
  initialRouterState,
  routeFailureWithPolicy,
  shouldInvokeModel,
} from "./failure-router";

describe("W4 — failure router + retry policy (D4)", () => {
  test("transient retries cap and stop", () => {
    const verdict = { kind: "classified" as const, category: "transient" as const };
    let state = initialRouterState();
    for (let i = 0; i < DEFAULT_RETRY_POLICY.maxTransientRetries; i++) {
      const decision = routeFailureWithPolicy(verdict, state);
      expect(decision.kind).toBe("route");
      if (decision.kind !== "route") return;
      expect(decision.invokeModel).toBe(true);
      state = decision.nextState;
    }
    const exhausted = routeFailureWithPolicy(verdict, state);
    expect(exhausted.kind).toBe("exhausted");
  });

  test("second model_capability on same lineage does not escalate again", () => {
    const verdict = { kind: "classified" as const, category: "model_capability" as const };
    const first = routeFailureWithPolicy(verdict, initialRouterState());
    expect(first.kind).toBe("route");
    if (first.kind !== "route") return;
    expect(first.nextState.tier).toBe("mid");

    const second = routeFailureWithPolicy(verdict, first.nextState);
    expect(second.kind).toBe("exhausted");
  });

  test("categories that must not spend model budget never invoke model path", () => {
    const verdict = { kind: "classified" as const, category: "apply_failure" as const };
    const decision = routeFailureWithPolicy(verdict, initialRouterState());
    expect(decision.kind).toBe("route");
    if (decision.kind !== "route") return;
    expect(decision.invokeModel).toBe(false);
    expect(shouldInvokeModel(routeVerdict(verdict))).toBe(false);
  });
});
