import { describe, expect, test } from "bun:test";
import {
  type AgentResult,
  classifyAmbiguousAsOneWay,
  classifyOneWay,
  classifyTwoWay,
  deriveMergeOutcome,
  freezeAcceptanceTarget,
  type GateReport,
  GateRunId,
  gateOutcome,
  InvocationId,
  isScopeCompliant,
  type Lineage,
  LineageId,
  lineagesConflict,
  makeWriteScope,
  parseContentHash,
  parseRepoPath,
  parseTimestamp,
  pathWithinScope,
  type RepoPath,
  RequirementId,
  type Result,
  regimeForDoor,
  routeCategory,
  routeVerdict,
  scopesOverlap,
  scopeViolations,
  spendsModelBudget,
  type WriteScope,
} from "./index";

const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  return result.value;
};

const path = (raw: string): RepoPath => must(parseRepoPath(raw));
const scope = (...paths: string[]): WriteScope => must(makeWriteScope(paths.map(path)));
const HASH = "a".repeat(64);
const ts = must(parseTimestamp(1_700_000_000_000));

describe("RepoPath", () => {
  test("normalizes redundant segments", () => {
    expect(path("./src/./domain/")).toBe("src/domain" as RepoPath);
  });

  test("folds segment case on darwin", () => {
    if (process.platform !== "darwin") return;
    expect(path("SRC/DOMAIN/gate.ts")).toBe("src/domain/gate.ts" as RepoPath);
  });

  test("rejects parent-escape and absolute paths", () => {
    expect(parseRepoPath("../etc/passwd").ok).toBe(false);
    expect(parseRepoPath("/abs/path").ok).toBe(false);
    expect(parseRepoPath("   ").ok).toBe(false);
    expect(parseRepoPath("src/\0/domain").ok).toBe(false);
  });
});

describe("WriteScope containment (D6)", () => {
  const s = scope("src/domain", "config");

  test("matches segment-wise, not by string prefix", () => {
    expect(pathWithinScope(s, path("src/domain/gate.ts"))).toBe(true);
    expect(pathWithinScope(s, path("src/domain"))).toBe(true);
    // "src/domainx" must NOT match the "src/domain" prefix.
    expect(pathWithinScope(s, path("src/domainx/x.ts"))).toBe(false);
    expect(pathWithinScope(s, path("src/other.ts"))).toBe(false);
  });

  test("empty scope is rejected at construction", () => {
    expect(makeWriteScope([]).ok).toBe(false);
  });

  test("overlap detection is symmetric and nesting-aware (D20)", () => {
    expect(scopesOverlap(scope("src"), scope("src/domain"))).toBe(true);
    expect(scopesOverlap(scope("src/domain"), scope("src"))).toBe(true);
    expect(scopesOverlap(scope("src/a"), scope("src/b"))).toBe(false);
  });
});

describe("Door & regime (D5, D25)", () => {
  test("one-way requires at least one trigger", () => {
    expect(classifyOneWay([]).ok).toBe(false);
    expect(classifyOneWay(["auth"]).ok).toBe(true);
  });

  test("regime is derived from the door", () => {
    expect(regimeForDoor(must(classifyOneWay(["money"])))).toBe("full");
    expect(regimeForDoor(classifyTwoWay())).toBe("minimal");
  });

  test("ambiguous defaults to one-way (conservative)", () => {
    expect(classifyAmbiguousAsOneWay([]).direction).toBe("one_way");
  });
});

describe("Acceptance target freeze (D7, D20)", () => {
  const hash = must(parseContentHash(HASH));

  test("rejects empty and duplicate criteria", () => {
    expect(freezeAcceptanceTarget({ targetHash: hash, criteria: [], frozenAt: ts }).ok).toBe(false);
    expect(
      freezeAcceptanceTarget({
        targetHash: hash,
        criteria: [
          { id: "c1", statement: "x" },
          { id: "c1", statement: "y" },
        ],
        frozenAt: ts,
      }).ok,
    ).toBe(false);
  });

  test("accepts well-formed criteria", () => {
    expect(
      freezeAcceptanceTarget({
        targetHash: hash,
        criteria: [{ id: "c1", statement: "merges on green" }],
        frozenAt: ts,
      }).ok,
    ).toBe(true);
  });
});

describe("Lineage conflict admission (D20)", () => {
  const lineage = (id: string, scopePath: string): Lineage => ({
    lineageId: must(LineageId(id)),
    requirementId: must(RequirementId(`req-${id}`)),
    door: classifyTwoWay(),
    acceptanceTarget: must(
      freezeAcceptanceTarget({
        targetHash: must(parseContentHash(HASH)),
        criteria: [{ id: "c1", statement: "done" }],
        frozenAt: ts,
      }),
    ),
    declaredScope: scope(scopePath),
    createdAt: ts,
  });

  test("conflicting scopes conflict; disjoint ones do not", () => {
    expect(lineagesConflict(lineage("a", "src/x"), lineage("b", "src/x/y"))).toBe(true);
    expect(lineagesConflict(lineage("a", "src/x"), lineage("b", "src/z"))).toBe(false);
  });

  test("a lineage never conflicts with itself", () => {
    expect(lineagesConflict(lineage("a", "src/x"), lineage("a", "src/x"))).toBe(false);
  });
});

describe("Agent result scope check (D6, D19)", () => {
  const s = scope("src/domain");
  const result = (...paths: string[]): AgentResult => ({
    invocationId: must(InvocationId("inv-1")),
    agentKind: "stub",
    outcome: "succeeded",
    edits: paths.map((p) => ({ path: path(p), operation: "modify" as const })),
    summary: "edit",
  });

  test("in-scope edits are compliant; out-of-scope are flagged", () => {
    expect(isScopeCompliant(result("src/domain/gate.ts"), s)).toBe(true);
    expect(scopeViolations(result("src/secrets.ts"), s)).toEqual([path("src/secrets.ts")]);
  });
});

describe("Failure routing (D4)", () => {
  test("each category routes to exactly one action", () => {
    expect(routeCategory("transient")).toBe("retry_same_tier");
    expect(routeCategory("model_capability")).toBe("escalate_one_tier");
    expect(routeCategory("spec_defect")).toBe("route_to_human");
    expect(routeCategory("scope_violation")).toBe("hard_reject");
    expect(routeCategory("oracle_tampering")).toBe("hard_reject");
    expect(routeCategory("environment")).toBe("fix_environment");
    expect(routeCategory("apply_failure")).toBe("control_plane_repair");
  });

  test("only transient and model_capability spend model budget", () => {
    expect(spendsModelBudget("transient")).toBe(true);
    expect(spendsModelBudget("model_capability")).toBe(true);
    expect(spendsModelBudget("spec_defect")).toBe(false);
  });

  test("a malformed verdict is never acted on as a classification", () => {
    expect(routeVerdict({ kind: "malformed", reason: "bad json" })).toBe("route_to_human");
    expect(routeVerdict({ kind: "classified", category: "transient" })).toBe("retry_same_tier");
  });
});

describe("Gate outcome (D8)", () => {
  const report = (...statuses: ("passed" | "failed" | "skipped")[]): GateReport => ({
    gateRunId: must(GateRunId("g1")),
    lineageId: must(LineageId("l1")),
    phase: "post",
    ranAt: ts,
    checks: statuses.map((status, i) => ({
      kind: i === 0 ? ("types" as const) : ("full_tests" as const),
      status,
    })),
  });

  test("red iff any check failed; skipped does not fail", () => {
    expect(gateOutcome(report("passed", "skipped"))).toBe("green");
    expect(gateOutcome(report("passed", "failed"))).toBe("red");
  });

  test("empty checks are red (fail closed)", () => {
    expect(
      gateOutcome({
        gateRunId: must(GateRunId("gate-empty")),
        lineageId: must(LineageId("l1")),
        phase: "post",
        ranAt: ts,
        checks: [],
      }),
    ).toBe("red");
  });
});

describe("Control-plane merge derivation (D19, W6)", () => {
  const twoWay = classifyTwoWay();
  const oneWay = must(classifyOneWay(["persisted_schema"]));

  test("two-way + green + in-scope + succeeded ⇒ merge", () => {
    expect(
      deriveMergeOutcome({
        door: twoWay,
        agentOutcome: "succeeded",
        postGate: "green",
        scopeCompliant: true,
      }),
    ).toEqual({ kind: "merge" });
  });

  test("one-way + green ⇒ await human (D11)", () => {
    expect(
      deriveMergeOutcome({
        door: oneWay,
        agentOutcome: "succeeded",
        postGate: "green",
        scopeCompliant: true,
      }),
    ).toEqual({ kind: "await_human" });
  });

  test("W6: a succeeded result with a red POST-gate does NOT advance state", () => {
    expect(
      deriveMergeOutcome({
        door: twoWay,
        agentOutcome: "succeeded",
        postGate: "red",
        scopeCompliant: true,
      }),
    ).toEqual({ kind: "hold", reason: "post_gate_red" });
  });

  test("a scope violation is terminal regardless of gate color (D6)", () => {
    expect(
      deriveMergeOutcome({
        door: twoWay,
        agentOutcome: "succeeded",
        postGate: "green",
        scopeCompliant: false,
      }),
    ).toEqual({ kind: "reject", reason: "scope_violation" });
  });
});
