import { describe, expect, test } from "bun:test";
import { classifyOneWay, classifyTwoWay, regimeForDoor } from "../domain/door";
import { INTEGRITY_FLOOR_PHASES, planForRegime } from "./regime-plan";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

/**
 * Phase 4 S4 — regime branch selection (D25).
 *
 * Ceremony scales with the door; the integrity floor does not.
 */
describe("P4/S4 — regime phase plan (D25)", () => {
  test("a one-way door runs the full regime: spec + plan + oracle authoring, then await human", () => {
    const plan = planForRegime("full");
    expect(plan.phases).toContain("spec");
    expect(plan.phases).toContain("plan");
    expect(plan.phases).toContain("oracle_authoring");
    expect(plan.terminal).toBe("await_human");
    // spec/plan precede implementation.
    expect(plan.phases.indexOf("spec")).toBeLessThan(plan.phases.indexOf("implement"));
  });

  test("a two-way door collapses to the minimal regime and auto-merges on green", () => {
    const minimal = planForRegime("minimal", { oracleCovered: true });
    expect(minimal.phases).not.toContain("spec");
    expect(minimal.phases).not.toContain("plan");
    // reused oracle ⇒ no dedicated test-author pass.
    expect(minimal.phases).not.toContain("oracle_authoring");
    expect(minimal.terminal).toBe("auto_merge");
  });

  test("minimal without coverage falls back to a test-author (oracle authoring) pass", () => {
    const withFallback = planForRegime("minimal", { oracleCovered: false });
    expect(withFallback.phases).toContain("oracle_authoring");
    expect(withFallback.terminal).toBe("auto_merge");
  });

  test("both regimes share the same integrity floor (implement + validate)", () => {
    for (const plan of [planForRegime("full"), planForRegime("minimal", { oracleCovered: true })]) {
      for (const floor of INTEGRITY_FLOOR_PHASES) {
        expect(plan.phases).toContain(floor);
      }
      // validate is always terminal-most among the floor phases.
      expect(plan.phases.indexOf("implement")).toBeLessThan(plan.phases.indexOf("validate"));
    }
  });

  test("the spike is orthogonal — present only when an open question is declared", () => {
    expect(planForRegime("minimal", { oracleCovered: true }).phases).not.toContain("spike");
    expect(
      planForRegime("minimal", { oracleCovered: true, hasOpenQuestion: true }).phases,
    ).toContain("spike");
  });

  test("regime is derived from the door, never disagreeing", () => {
    expect(planForRegime(regimeForDoor(classifyTwoWay())).terminal).toBe("auto_merge");
    expect(planForRegime(regimeForDoor(must(classifyOneWay(["money"])))).terminal).toBe(
      "await_human",
    );
  });
});
