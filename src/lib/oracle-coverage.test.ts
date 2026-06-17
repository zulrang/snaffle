import { describe, expect, test } from "bun:test";
import { classifyOneWay, classifyTwoWay } from "../domain/door";
import { decideOracleCoverage } from "./oracle-coverage";
import { selectRegimePlan } from "./regime-plan";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W6 — oracle coverage + regime selection (D25)", () => {
  test("a frozen oracle covering every criterion is reused", () => {
    const decision = decideOracleCoverage({
      requiredCriteria: ["c1", "c2"],
      frozenOracleCriteria: ["c1", "c2", "c3"],
    });
    expect(decision.kind).toBe("reuse");
  });

  test("an absent frozen oracle falls back to authoring", () => {
    const decision = decideOracleCoverage({ requiredCriteria: ["c1"] });
    expect(decision.kind).toBe("author");
    if (decision.kind !== "author") return;
    expect(decision.reason).toBe("no_frozen_oracle");
  });

  test("partial coverage falls back to authoring with the uncovered criteria named", () => {
    const decision = decideOracleCoverage({
      requiredCriteria: ["c1", "c2"],
      frozenOracleCriteria: ["c1"],
    });
    expect(decision.kind).toBe("author");
    if (decision.kind !== "author") return;
    expect(decision.reason).toBe("uncovered_criteria");
    expect(decision.uncovered).toEqual(["c2"]);
  });

  test("the decision is deterministic for identical inputs", () => {
    const input = { requiredCriteria: ["c1", "c2"], frozenOracleCriteria: ["c1"] };
    expect(decideOracleCoverage(input)).toEqual(decideOracleCoverage(input));
  });

  test("minimal-with-coverage collapses oracle-authoring", () => {
    const plan = selectRegimePlan(classifyTwoWay(), {
      kind: "reuse",
      coveredCriteria: ["c1"],
    });
    expect(plan.regime).toBe("minimal");
    expect(plan.phases).not.toContain("oracle_authoring");
    expect(plan.terminal).toBe("auto_merge");
  });

  test("minimal-without-coverage keeps a test-author (oracle-authoring) pass", () => {
    const plan = selectRegimePlan(classifyTwoWay(), {
      kind: "author",
      reason: "no_frozen_oracle",
      uncovered: ["c1"],
    });
    expect(plan.phases).toContain("oracle_authoring");
    expect(plan.terminal).toBe("auto_merge");
  });

  test("full never collapses oracle-authoring or the human hold, even with coverage", () => {
    const plan = selectRegimePlan(must(classifyOneWay(["money"])), {
      kind: "reuse",
      coveredCriteria: ["c1"],
    });
    expect(plan.regime).toBe("full");
    expect(plan.phases).toContain("oracle_authoring");
    expect(plan.terminal).toBe("await_human");
  });
});
