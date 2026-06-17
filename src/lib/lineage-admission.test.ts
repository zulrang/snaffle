import { describe, expect, test } from "bun:test";
import { AttemptId, BatchId, DecisionId, LineageId, WorktreeId } from "../domain/ids";
import { admitLineage, admittedState, isAdmitted, runningFromAdmitted } from "./lineage-admission";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W2 — decision/lineage id + state types (D11, D20)", () => {
  test("DecisionId and BatchId smart constructors validate non-empty ids", () => {
    expect(DecisionId("dec-1").ok).toBe(true);
    expect(BatchId("batch-1").ok).toBe(true);
    expect(DecisionId("").ok).toBe(false);
    expect(BatchId("  ").ok).toBe(false);
  });

  test("AttemptId and WorktreeId smart constructors validate non-empty ids", () => {
    expect(AttemptId("attempt-1").ok).toBe(true);
    expect(WorktreeId("wt-1").ok).toBe(true);
    expect(AttemptId("").ok).toBe(false);
  });

  test("admitLineage produces admitted state with attempt and worktree ids", () => {
    const admission = must(
      admitLineage({
        lineageId: must(LineageId("L1")),
        attemptSeq: 1,
        worktreeSeq: 0,
      }),
    );
    expect(admission.state).toEqual(admittedState());
    expect(isAdmitted(admission.state)).toBe(true);
    expect(String(admission.attemptId)).toContain("L1");
    expect(String(admission.worktreeId)).toContain("L1");
  });

  test("admitted is distinct from running — running begins only after admission", () => {
    expect(admittedState()).toEqual({ status: "admitted" });
    expect(runningFromAdmitted("implement")).toEqual({ status: "running", phase: "implement" });
    expect(isAdmitted(runningFromAdmitted("implement"))).toBe(false);
  });
});
