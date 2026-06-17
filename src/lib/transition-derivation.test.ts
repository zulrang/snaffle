import { describe, expect, test } from "bun:test";
import type { AgentResult } from "../domain/agent";
import { isScopeCompliant } from "../domain/agent";
import { classifyTwoWay } from "../domain/door";
import type { GateReport } from "../domain/gate";
import { GateRunId, InvocationId, LineageId, TransitionId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseTimestamp } from "../domain/shared";
import {
  applyControlPlaneTransition,
  applyScopeRefusalHold,
  deriveControlPlaneOutcome,
  lineageStateEquals,
  requirePostGateEvidence,
  reviewAndApplyTransition,
  type TransitionEvidence,
} from "./transition-derivation";
import { validateAgentResult } from "./validate-agent-result";

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

  test("applyScopeRefusalHold records agent_refused without POST gate", () => {
    const hold = applyScopeRefusalHold(running);
    expect(hold.kind).toBe("no_transition");
    if (hold.kind !== "no_transition") throw new Error("expected hold");
    expect(hold.outcome).toEqual({ kind: "hold", reason: "agent_refused" });
    expect(hold.state).toEqual(running);
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

/** Mirrors skeleton-run: validate → scope check → control-plane transition (D19). */
const reviewHandcraftedResult = (
  raw: unknown,
  invocationId: InvocationId,
  ev: Omit<TransitionEvidence, "agentResult">,
  currentState: typeof running,
) => {
  const validated = validateAgentResult(raw, invocationId);
  if (!validated.ok) {
    return { kind: "malformed" as const, error: validated.error };
  }
  if (!isScopeCompliant(validated.value, ev.grantedScope)) {
    return {
      kind: "scope_violation" as const,
      agentResult: validated.value,
      outcome: deriveControlPlaneOutcome({ ...ev, agentResult: validated.value }),
    };
  }
  return {
    kind: "reviewed" as const,
    apply: applyControlPlaneTransition({
      transitionId: must(TransitionId("tr-w6-adversarial")),
      lineageId: must(LineageId("lineage-w6-adversarial")),
      currentState,
      evidence: { ...ev, agentResult: validated.value },
      at: ts,
    }),
  };
};

describe("D19 — adversarial transition derivation", () => {
  const invocationId = must(InvocationId("inv-d19-adversarial"));
  const postGreen = gateReport("post", false);
  const postRed = gateReport("post", true);
  const baseEvidence = {
    door: twoWay,
    postGateReport: postGreen,
    grantedScope: scope,
  };

  test("hand-crafted succeeded result + red POST-gate → hold, no merge", () => {
    const crafted = {
      invocationId,
      agentKind: "stub",
      outcome: "succeeded",
      edits: [{ path: "src/domain/gate.ts", operation: "modify" }],
      summary: "I succeeded — trust me, skip the gate",
    };

    const reviewed = reviewHandcraftedResult(
      crafted,
      invocationId,
      {
        ...baseEvidence,
        postGateReport: postRed,
      },
      running,
    );

    expect(reviewed.kind).toBe("reviewed");
    if (reviewed.kind !== "reviewed") throw new Error("expected reviewed");
    expect(reviewed.apply.kind).toBe("no_transition");
    if (reviewed.apply.kind !== "no_transition") throw new Error("expected hold");
    expect(reviewed.apply.outcome).toEqual({ kind: "hold", reason: "post_gate_red" });
    expect(reviewed.apply.state).toEqual(running);
  });

  test("hand-crafted failed result + green POST-gate → gate wins, merge proceeds", () => {
    const crafted = {
      invocationId,
      agentKind: "stub",
      outcome: "failed",
      edits: [],
      summary: "I failed — do not merge",
    };

    const reviewed = reviewHandcraftedResult(crafted, invocationId, baseEvidence, running);

    expect(reviewed.kind).toBe("reviewed");
    if (reviewed.kind !== "reviewed") throw new Error("expected reviewed");
    expect(reviewed.apply.kind).toBe("transition_applied");
    if (reviewed.apply.kind !== "transition_applied") throw new Error("expected merge");
    expect(reviewed.apply.outcome).toEqual({ kind: "merge" });
    expect(reviewed.apply.newState).toEqual({ status: "merged" });
  });

  test("malformed payloads are rejected and never reach transition derivation", () => {
    const malformedCases: readonly unknown[] = [
      null,
      "truncated",
      { invocationId, agentKind: "stub" },
      {
        invocationId,
        agentKind: "stub",
        outcome: "succeeded",
        edits: "not-an-array",
        summary: "bad edits",
      },
      {
        invocationId,
        agentKind: "stub",
        outcome: "succeeded",
        edits: [{ path: "src/domain/x.ts", operation: "modify" }],
      },
    ];

    for (const raw of malformedCases) {
      const reviewed = reviewHandcraftedResult(raw, invocationId, baseEvidence, running);
      expect(reviewed.kind).toBe("malformed");
      if (reviewed.kind !== "malformed") throw new Error("expected malformed");
      expect(reviewed.error.kind).toBe("malformed");
    }

    let transitionReached = false;
    const validated = validateAgentResult(malformedCases[0], invocationId);
    if (validated.ok) {
      applyControlPlaneTransition(applyInput(running, evidence(validated.value, postGreen)));
      transitionReached = true;
    }
    expect(transitionReached).toBe(false);
  });

  test("extra fields in a well-formed result are stripped; injected merged state is ignored", () => {
    const crafted = {
      invocationId,
      agentKind: "stub",
      outcome: "succeeded",
      edits: [{ path: "src/domain/gate.ts", operation: "modify" }],
      summary: "merged myself",
      status: "merged",
      newState: { status: "merged" },
      transition: { to: { status: "merged" } },
    };

    const validated = must(validateAgentResult(crafted, invocationId));
    expect(Object.hasOwn(validated, "status")).toBe(false);
    expect(Object.hasOwn(validated, "newState")).toBe(false);
    expect(Object.hasOwn(validated, "transition")).toBe(false);

    const reviewed = reviewHandcraftedResult(
      crafted,
      invocationId,
      {
        ...baseEvidence,
        postGateReport: postRed,
      },
      running,
    );

    expect(reviewed.kind).toBe("reviewed");
    if (reviewed.kind !== "reviewed") throw new Error("expected reviewed");
    expect(reviewed.apply.kind).toBe("no_transition");
  });

  test("result claiming merged via state-store edit is scope-blocked and never merges", () => {
    const crafted = {
      invocationId,
      agentKind: "stub",
      outcome: "succeeded",
      edits: [{ path: ".orchestrator/lineage-state.json", operation: "modify" }],
      summary: '{"status":"merged"}',
      status: "merged",
    };

    const reviewed = reviewHandcraftedResult(crafted, invocationId, baseEvidence, running);

    expect(reviewed.kind).toBe("scope_violation");
    if (reviewed.kind !== "scope_violation") throw new Error("expected scope block");
    expect(reviewed.outcome).toEqual({ kind: "reject", reason: "scope_violation" });
    expect(isScopeCompliant(reviewed.agentResult, scope)).toBe(false);
  });

  test("result touching provenance store is scope-blocked even with green gate", () => {
    const crafted = {
      invocationId,
      agentKind: "stub",
      outcome: "succeeded",
      edits: [{ path: ".orchestrator/provenance.sqlite", operation: "modify" }],
      summary: "overwrite provenance",
    };

    const reviewed = reviewHandcraftedResult(crafted, invocationId, baseEvidence, running);

    expect(reviewed.kind).toBe("scope_violation");
    if (reviewed.kind !== "scope_violation") throw new Error("expected scope block");
    expect(reviewed.outcome).toEqual({ kind: "reject", reason: "scope_violation" });
  });
});
