import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import {
  assertCanonicalPhaseOrder,
  EXPAND_CONTRACT_PHASES,
  EXPAND_CONTRACT_PLAN_REL,
  emitExpandContractPlan,
  loadExpandContractPlan,
  saveExpandContractPlan,
  verifyExpandContractPlanIntegrity,
} from "./expand-contract";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));
const lineageId = must(LineageId("lineage-w2-schema"));

describe("W2 — expand/contract emitter (D9)", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("stateful input emits a stable content-addressed five-phase plan", () => {
    const a = must(emitExpandContractPlan({ lineageId, statefulKind: "stateful", frozenAt: ts }));
    const b = must(emitExpandContractPlan({ lineageId, statefulKind: "stateful", frozenAt: ts }));
    expect(a.planHash).toBe(b.planHash);
    expect(a.phases.map((p) => p.phase)).toEqual([...EXPAND_CONTRACT_PHASES]);
    for (const phase of a.phases) {
      expect(phase.doneWhen.length).toBeGreaterThan(0);
      expect(phase.artifactPath).toContain(String(lineageId));
    }
  });

  test("non-stateful input refuses a plan (no-op)", () => {
    const result = emitExpandContractPlan({
      lineageId,
      statefulKind: "non_stateful",
      frozenAt: ts,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("non_stateful");
  });

  test("reordering or skipping phases is refused", () => {
    const plan = must(
      emitExpandContractPlan({ lineageId, statefulKind: "stateful", frozenAt: ts }),
    );
    const reordered = [...plan.phases].reverse();
    const check = assertCanonicalPhaseOrder(reordered);
    expect(check.ok).toBe(false);
  });

  test("plan persists, reloads, and detects tampering", () => {
    workspace = mkdtempSync(join(tmpdir(), "w2-expand-"));
    const plan = must(
      emitExpandContractPlan({ lineageId, statefulKind: "stateful", frozenAt: ts }),
    );
    must(saveExpandContractPlan(workspace, EXPAND_CONTRACT_PLAN_REL, plan));
    const loaded = must(loadExpandContractPlan(workspace, EXPAND_CONTRACT_PLAN_REL));
    expect(loaded).toBeDefined();
    if (loaded === undefined) return;
    must(verifyExpandContractPlanIntegrity(loaded));

    const tampered = { ...loaded, planHash: "0".repeat(64) as typeof loaded.planHash };
    const integrity = verifyExpandContractPlanIntegrity(tampered);
    expect(integrity.ok).toBe(false);
  });
});
