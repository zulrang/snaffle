import { describe, expect, test } from "bun:test";
import type { AgentResult } from "../domain/agent";
import { classifyTwoWay } from "../domain/door";
import type { GateReport } from "../domain/gate";
import { GateRunId, InvocationId, LineageId, TransitionId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseTimestamp } from "../domain/shared";
import {
  applyControlPlaneTransition,
  deriveControlPlaneOutcome,
  lineageStateEquals,
  requirePostGateEvidence,
  reviewAndApplyTransition,
  type TransitionEvidence,
} from "./transition-derivation";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));
const scope = must(makeWriteScope([must(parseRepoPath("src/domain"))]));
const twoWay = classifyTwoWay();
const running = { status: "running" as const, phase: "implement" as const };

const agentResult = (
  outcome: AgentResult["outcome"],
  path = "src/domain/gate.ts",
): AgentResult => ({
  invocationId: must(InvocationId("inv-w6-1")),
  agentKind: "stub",
  outcome,
  edits: [{ path: must(parseRepoPath(path)), operation: "modify" }],
  summary: "stub edit",
});

const gateReport = (phase: GateReport["phase"], failed: boolean): GateReport => ({
  gateRunId: must(GateRunId("gate-w6-post")),
  lineageId: must(LineageId("lineage-w6")),
  phase,
  ranAt: ts,
  checks: [{ kind: "full_tests", status: failed ? "failed" : "passed" }],
});

const evidence = (agent: AgentResult, post: GateReport): TransitionEvidence => ({
  door: twoWay,
  agentResult: agent,
  postGateReport: post,
  grantedScope: scope,
});

const applyInput = (current: typeof running, ev: TransitionEvidence) => ({
  transitionId: must(TransitionId("tr-w6-1")),
  lineageId: must(LineageId("lineage-w6")),
  currentState: current,
  evidence: ev,
  at: ts,
});

describe("transition derivation — unit cases", () => {
  test("deriveControlPlaneOutcome matches domain deriveMergeOutcome", () => {
    expect(
      deriveControlPlaneOutcome(evidence(agentResult("succeeded"), gateReport("post", false))),
    ).toEqual({ kind: "merge" });
  });

  test("requirePostGateEvidence rejects PRE-gate reports", () => {
    const result = requirePostGateEvidence(
      evidence(agentResult("succeeded"), gateReport("pre", false)),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing post gate");
    expect(result.error.kind).toBe("missing_post_gate");
  });

  test("requirePostGateEvidence rejects empty gate checks", () => {
    const emptyPost: GateReport = {
      gateRunId: must(GateRunId("gate-w6-empty")),
      lineageId: must(LineageId("lineage-w6")),
      phase: "post",
      ranAt: ts,
      checks: [],
    };
    const result = requirePostGateEvidence(evidence(agentResult("succeeded"), emptyPost));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected empty gate checks");
    expect(result.error.kind).toBe("empty_gate_checks");
  });

  test("applyControlPlaneTransition throws without POST gate evidence", () => {
    expect(() =>
      applyControlPlaneTransition(
        applyInput(running, evidence(agentResult("succeeded"), gateReport("pre", false))),
      ),
    ).toThrow(/POST gate evidence/);
  });
});

describe("W6 — control-plane transition derivation (D19)", () => {
  test("a well-formed result with a red POST-gate does NOT advance state", () => {
    const ev = evidence(agentResult("succeeded"), gateReport("post", true));
    const result = applyControlPlaneTransition(applyInput(running, ev));

    expect(result.kind).toBe("no_transition");
    if (result.kind !== "no_transition") throw new Error("expected hold");
    expect(result.outcome).toEqual({ kind: "hold", reason: "post_gate_red" });
    expect(lineageStateEquals(result.state, running)).toBe(true);
  });

  test("merge transition occurs only via the control-plane decision, never from the result directly", () => {
    const succeeded = agentResult("succeeded");

    const withoutPostGate = reviewAndApplyTransition(
      applyInput(running, evidence(succeeded, gateReport("pre", false))),
    );
    expect(withoutPostGate.ok).toBe(false);

    const withRedPost = applyControlPlaneTransition(
      applyInput(running, evidence(succeeded, gateReport("post", true))),
    );
    expect(withRedPost.kind).toBe("no_transition");

    const withGreenPost = applyControlPlaneTransition(
      applyInput(running, evidence(succeeded, gateReport("post", false))),
    );
    expect(withGreenPost.kind).toBe("transition_applied");
    if (withGreenPost.kind !== "transition_applied") throw new Error("expected merge");
    expect(withGreenPost.newState).toEqual({ status: "merged" });
    expect(withGreenPost.transition.basis.invocationId).toBe(succeeded.invocationId);
    expect(withGreenPost.transition.basis.gateRunId).toBe(must(GateRunId("gate-w6-post")));
  });
});
