import { describe, expect, test } from "bun:test";
import { classifyTwoWay } from "../domain/door";
import { LineageId, RequirementId } from "../domain/ids";
import {
  freezeAcceptanceTarget,
  type Lineage,
  lineagesConflict,
  makeLineage,
} from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";

/**
 * P5/S2 — deterministic conflict admission + back-pressure.
 *
 * Retires the scheduling-liveness risk: a candidate lineage is admitted unless
 * its DECLARED scope conflicts with an in-flight lineage, in which case it is
 * back-pressured behind ONLY the conflictor — non-conflicting work is never
 * blocked, completing the conflictor releases the waiter, and admission is
 * deterministic. Prototype admit() lives here; the real one is W3 (lib/).
 */

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

type Admission =
  | { readonly kind: "admitted" }
  | { readonly kind: "back_pressured"; readonly behind: string };

// Prototype of W3's admission rule: back-pressure behind the deterministically
// first conflictor (by lineage id); no conflict ⇒ admit immediately.
const admit = (candidate: Lineage, inFlight: readonly Lineage[]): Admission => {
  const conflictors = inFlight
    .filter((l) => lineagesConflict(candidate, l))
    .map((l) => String(l.lineageId))
    .sort((a, b) => a.localeCompare(b));
  return conflictors[0] === undefined
    ? { kind: "admitted" }
    : { kind: "back_pressured", behind: conflictors[0] };
};

const A = lineageWith("A", ["src/lib"]);
const B = lineageWith("B", ["src/domain"]);
const C = lineageWith("C", ["src/lib/foo"]); // overlaps A

describe("P5/S2 — conflict admission + back-pressure", () => {
  test("a non-conflicting candidate is admitted while a lineage is in-flight", () => {
    expect(admit(B, [A]).kind).toBe("admitted");
  });

  test("a conflicting candidate is back-pressured behind its conflictor", () => {
    const decision = admit(C, [A]);
    expect(decision.kind).toBe("back_pressured");
    if (decision.kind !== "back_pressured") return;
    expect(decision.behind).toBe("A");
  });

  test("back-pressure is behind ONLY the conflictor — unrelated in-flight work is ignored", () => {
    const decision = admit(C, [B, A]);
    expect(decision.kind).toBe("back_pressured");
    if (decision.kind !== "back_pressured") return;
    expect(decision.behind).toBe("A"); // not B, which does not overlap C
  });

  test("completing the conflictor releases the waiter (no deadlock)", () => {
    expect(admit(C, [A]).kind).toBe("back_pressured");
    expect(admit(C, []).kind).toBe("admitted"); // A done ⇒ C admits
  });

  test("admission is deterministic for a fixed input", () => {
    expect(admit(C, [A, B])).toEqual(admit(C, [A, B]));
  });

  test("a lineage never conflicts with itself (same-lineage remediation stays actionable)", () => {
    expect(lineagesConflict(A, A)).toBe(false);
    expect(admit(A, [A]).kind).toBe("admitted");
  });
});
