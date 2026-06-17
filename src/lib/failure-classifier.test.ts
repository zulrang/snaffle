import { describe, expect, test } from "bun:test";
import { routeVerdict } from "../domain/failure";
import type { GateReport } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import {
  classifyAndRoute,
  classifyFailure,
  validateFailureVerdictPacket,
} from "./failure-classifier";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1));

const gateReport = (
  ...failed: ("types" | "oracle_integrity" | "lint" | "spec_traceability")[]
): GateReport => ({
  gateRunId: must(GateRunId("g1")),
  lineageId: must(LineageId("l1")),
  phase: "post" as const,
  ranAt: ts,
  checks: failed.map((kind) => ({ kind, status: "failed" as const, detail: kind })),
});

const categoryOf = (evidence: Parameters<typeof classifyFailure>[0]) => {
  const verdict = classifyFailure(evidence);
  expect(verdict.kind).toBe("classified");
  if (verdict.kind !== "classified") throw new Error("expected classified");
  return verdict.category;
};

describe("S2/W3 — failure classifier (D4)", () => {
  test("each D4 category has a fixture", () => {
    expect(categoryOf({ kind: "gate_report", report: gateReport("lint") })).toBe("transient");
    expect(categoryOf({ kind: "gate_report", report: gateReport("types") })).toBe(
      "model_capability",
    );
    expect(categoryOf({ kind: "gate_report", report: gateReport("spec_traceability") })).toBe(
      "spec_defect",
    );
    expect(categoryOf({ kind: "gate_report", report: gateReport("oracle_integrity") })).toBe(
      "oracle_tampering",
    );
    expect(categoryOf({ kind: "scope_violation", paths: ["src/x.ts"] })).toBe("scope_violation");
    expect(categoryOf({ kind: "apply_error", detail: "disk full" })).toBe("apply_failure");
    expect(categoryOf({ kind: "agent_outcome", outcome: "failed", summary: "timeout" })).toBe(
      "model_capability",
    );
    expect(
      categoryOf({
        kind: "environment_fault",
        detail: "spawn ECONNREFUSED",
        transient: true,
      }),
    ).toBe("transient");
    expect(categoryOf({ kind: "environment_fault", detail: "missing binary" })).toBe("environment");
    expect(categoryOf({ kind: "spec_hint", category: "underspecified" })).toBe("underspecified");
    expect(categoryOf({ kind: "spec_hint", category: "contradictory" })).toBe("contradictory");
  });

  test("apply_failure routes to control_plane_repair, not retry", () => {
    const { action } = classifyAndRoute({ kind: "apply_error", detail: "apply failed" });
    expect(action).toBe("control_plane_repair");
  });

  test("malformed verdict packet routes to human via routeVerdict", () => {
    const verdict = validateFailureVerdictPacket({ kind: "classified", category: "not_real" });
    expect(verdict.kind).toBe("malformed");
    expect(routeVerdict(verdict)).toBe("route_to_human");
  });

  test("valid external packet is accepted", () => {
    const verdict = validateFailureVerdictPacket({
      kind: "classified",
      category: "transient",
      detail: "flake",
    });
    expect(verdict).toEqual({ kind: "classified", category: "transient", detail: "flake" });
  });
});
