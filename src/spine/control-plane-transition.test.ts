import { describe, expect, test } from "bun:test";
import type { AgentResult } from "../domain/agent";
import { classifyTwoWay } from "../domain/door";
import type { GateReport } from "../domain/gate";
import { GateRunId, InvocationId, LineageId, RequirementId, TransitionId } from "../domain/ids";
import { freezeAcceptanceTarget, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import { reviewLineageTransition } from "./control-plane-transition";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));
const scope = must(makeWriteScope([must(parseRepoPath("src/domain"))]));

const lineage = makeLineage({
  lineageId: must(LineageId("lineage-w6-spine")),
  requirementId: must(RequirementId("req-w6")),
  door: classifyTwoWay(),
  acceptanceTarget: must(
    freezeAcceptanceTarget({
      targetHash: must(parseContentHash("a".repeat(64))),
      criteria: [{ id: "c1", statement: "gate passes" }],
      frozenAt: ts,
    }),
  ),
  declaredScope: scope,
  createdAt: ts,
});

const running = { status: "running" as const, phase: "validate" as const };

const agentResult: AgentResult = {
  invocationId: must(InvocationId("inv-w6-spine")),
  agentKind: "stub",
  outcome: "succeeded",
  edits: [{ path: must(parseRepoPath("src/domain/gate.ts")), operation: "modify" }],
  summary: "applied edit",
};

const postGate = (failed: boolean): GateReport => ({
  gateRunId: must(GateRunId("gate-w6-spine-post")),
  lineageId: lineage.lineageId,
  phase: "post",
  ranAt: ts,
  checks: [{ kind: "full_tests", status: failed ? "failed" : "passed" }],
});

describe("W6 — spine control-plane transition review (D19)", () => {
  test("reviewLineageTransition holds state when POST-gate is red", () => {
    const reviewed = must(
      reviewLineageTransition({
        lineage,
        currentState: running,
        evidence: {
          door: lineage.door,
          agentResult,
          postGateReport: postGate(true),
          grantedScope: scope,
        },
        transitionId: must(TransitionId("tr-w6-spine-hold")),
        at: ts,
      }),
    );

    expect(reviewed.kind).toBe("no_transition");
    if (reviewed.kind !== "no_transition") throw new Error("expected hold");
    expect(reviewed.state).toEqual(running);
  });

  test("reviewLineageTransition merges only after green POST-gate review", () => {
    const reviewed = must(
      reviewLineageTransition({
        lineage,
        currentState: running,
        evidence: {
          door: lineage.door,
          agentResult,
          postGateReport: postGate(false),
          grantedScope: scope,
        },
        transitionId: must(TransitionId("tr-w6-spine-merge")),
        at: ts,
      }),
    );

    expect(reviewed.kind).toBe("transition_applied");
    if (reviewed.kind !== "transition_applied") throw new Error("expected merge");
    expect(reviewed.newState).toEqual({ status: "merged" });
  });
});
