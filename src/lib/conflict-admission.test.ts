import { describe, expect, test } from "bun:test";
import { classifyTwoWay } from "../domain/door";
import { LineageId, RequirementId } from "../domain/ids";
import { freezeAcceptanceTarget, type Lineage, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import { admitCandidate, conflictorsCleared } from "./conflict-admission";

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

describe("W3 — conflict admission in lib/ (D20)", () => {
  test("a non-conflicting candidate is admitted while lineages are in-flight", () => {
    expect(admitCandidate(B, [A]).kind).toBe("admitted");
  });

  test("a conflicting candidate is back-pressured behind its conflictor", () => {
    const decision = admitCandidate(C, [A]);
    expect(decision.kind).toBe("back_pressured");
    if (decision.kind !== "back_pressured") return;
    expect(String(decision.behind)).toBe("A");
  });

  test("with many in-flight, back-pressure is behind only the conflictor", () => {
    const decision = admitCandidate(C, [B, A]);
    expect(decision.kind).toBe("back_pressured");
    if (decision.kind !== "back_pressured") return;
    expect(String(decision.behind)).toBe("A");
  });

  test("completing the conflictor admits the waiter", () => {
    expect(admitCandidate(C, [A]).kind).toBe("back_pressured");
    expect(conflictorsCleared(C, [])).toBe(true);
  });

  test("admission is deterministic for a fixed input", () => {
    expect(admitCandidate(C, [A, B])).toEqual(admitCandidate(C, [A, B]));
  });

  test("declared scope — not inferred diff — is the admission input", () => {
    // C overlaps A by declared prefix, not by any runtime diff.
    expect(admitCandidate(C, [A]).kind).toBe("back_pressured");
    expect(admitCandidate(B, [A]).kind).toBe("admitted");
  });
});
