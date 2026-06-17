import { describe, expect, test } from "bun:test";
import { classifyTwoWay } from "../domain/door";
import { LineageId, RequirementId } from "../domain/ids";
import { freezeAcceptanceTarget, type Lineage, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import { batchComplete, planNextAdmissions } from "./lineage-scheduler";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));

const lineageWith = (id: string, paths: readonly string[]): Lineage =>
  makeLineage({
    lineageId: must(LineageId(id)),
    requirementId: must(RequirementId(`req-${id}`)),
    door: classifyTwoWay(),
    acceptanceTarget: must(
      freezeAcceptanceTarget({
        targetHash: must(parseContentHash("a".repeat(64))),
        criteria: [{ id: "c1", statement: "s" }],
        frozenAt: ts,
      }),
    ),
    declaredScope: must(makeWriteScope(paths.map((p) => must(parseRepoPath(p))))),
    createdAt: ts,
  });

const A = lineageWith("A", ["src/lib"]);
const B = lineageWith("B", ["src/domain"]);
const C = lineageWith("C", ["src/lib/foo"]);
const D = lineageWith("D", ["src/spine"]);

describe("W4 — admission planning (D20)", () => {
  test("non-conflicting lineages fill available parallel slots", () => {
    const plan = planNextAdmissions([A, B, D], [], 2);
    expect(plan.admit.map((l) => String(l.lineageId))).toEqual(["A", "B"]);
    expect(plan.defer.map((l) => String(l.lineageId))).toEqual(["D"]);
  });

  test("a conflicting candidate defers while its conflictor is in-flight", () => {
    const plan = planNextAdmissions([C, B], [A], 2);
    expect(plan.admit.map((l) => String(l.lineageId))).toEqual(["B"]);
    expect(plan.defer.map((l) => String(l.lineageId))).toEqual(["C"]);
  });

  test("batchComplete is true only when pending and in-flight are both empty", () => {
    expect(batchComplete([], [])).toBe(true);
    expect(batchComplete([A], [])).toBe(false);
    expect(batchComplete([], [A])).toBe(false);
  });
});
