import { describe, expect, test } from "bun:test";
import { classifyOneWay } from "../domain/door";
import { LineageId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseTimestamp } from "../domain/shared";
import {
  EXPAND_CONTRACT_PHASES,
  emitExpandContractPlan,
  verifyExpandContractPlanIntegrity,
} from "../lib/expand-contract";
import { detectStatefulChange } from "../lib/stateful-change";

/**
 * P6/S1 — expand/contract plan from stateful door signals.
 *
 * Retires irreversibility risk: stateful scopes get a stable five-phase plan;
 * non-stateful scopes get no plan. Real implementation is W1/W2 in lib/.
 */

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));

describe("P6/S1 — expand/contract plan from stateful signals", () => {
  test("a schema-touching scope produces a stable content-addressed plan", () => {
    const scope = must(makeWriteScope([must(parseRepoPath("db/migrations/001.sql"))]));
    const door = must(classifyOneWay(["persisted_schema"]));
    expect(detectStatefulChange({ scope, door })).toBe("stateful");

    const lineageId = must(LineageId("L-s1-schema"));
    const plan = must(
      emitExpandContractPlan({ lineageId, statefulKind: "stateful", frozenAt: ts }),
    );
    expect(plan.phases.map((p) => p.phase)).toEqual([...EXPAND_CONTRACT_PHASES]);
    must(verifyExpandContractPlanIntegrity(plan));
    expect(
      must(emitExpandContractPlan({ lineageId, statefulKind: "stateful", frozenAt: ts })).planHash,
    ).toBe(plan.planHash);
  });

  test("a non-stateful two-way scope yields no expand/contract plan", () => {
    const scope = must(makeWriteScope([must(parseRepoPath("src/lib/a.ts"))]));
    const kind = detectStatefulChange({
      scope,
      door: { direction: "two_way" },
    });
    expect(kind).toBe("non_stateful");
    const result = emitExpandContractPlan({
      lineageId: must(LineageId("L-s1-tw")),
      statefulKind: kind,
      frozenAt: ts,
    });
    expect(result.ok).toBe(false);
  });
});
