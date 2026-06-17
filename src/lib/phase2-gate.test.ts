import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateCheckKind } from "../domain/gate";
import { compareCheckKind, gateOutcome } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import {
  defaultPhase1GateConfig,
  resolveStagesForTier,
  TIER_AFFECTED_KINDS,
  TIER_FULL_KINDS,
} from "./gate-config";
import {
  GATE_DETERMINISTIC_ENTRY,
  type GateRunTrace,
  runDeterministicGate,
  runGateForTier,
} from "./gate-runner";
import {
  buildOracleFreezeRecord,
  checkOracleMutationAllowed,
  saveOracleFreezeRecord,
} from "./oracle-freeze";
import { evaluateToolCallUnderGrant } from "./scope-guard";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W1 — multi-stage gate runner (D8/D12)", () => {
  test("runs stages in canonical order and fail-fast", async () => {
    const order: GateCheckKind[] = [];
    const config = {
      ...defaultPhase1GateConfig(),
      stages: [
        { kind: "lint" as const, command: ["sh", "-c", "exit 0"] },
        { kind: "types" as const, command: ["sh", "-c", "exit 1"] },
        { kind: "full_tests" as const, command: ["sh", "-c", "exit 0"] },
      ],
    };

    const report = await runDeterministicGate(
      {
        gateRunId: must(GateRunId("gate-ms-1")),
        lineageId: must(LineageId("lineage-ms-1")),
        phase: "pre",
        worktreeRoot: ".",
        config,
      },
      {
        onTrace: (trace) => {
          order.push(trace.kind);
        },
      },
    );

    expect(order).toEqual(["lint", "types"]);
    expect(report.checks).toHaveLength(2);
    expect(gateOutcome(report)).toBe("red");
  });

  test("PRE and POST share the same stage set trace entry", async () => {
    const traces: GateRunTrace[] = [];
    const config = defaultPhase1GateConfig();
    const input = {
      gateRunId: must(GateRunId("gate-ms-2")),
      lineageId: must(LineageId("lineage-ms-2")),
      worktreeRoot: ".",
      config,
    };
    const options = {
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      onTrace: (trace: GateRunTrace) => traces.push(trace),
    };

    await runDeterministicGate({ ...input, phase: "pre" }, options);
    await runDeterministicGate(
      { ...input, phase: "post", gateRunId: must(GateRunId("gate-ms-3")) },
      options,
    );

    expect(traces.every((trace) => trace.entry === GATE_DETERMINISTIC_ENTRY)).toBe(true);
    expect(traces[0]?.kind).toBe(traces[1]?.kind);
  });
});

describe("W2 — affected/full tiers (D12)", () => {
  test("both tiers dispatch the same stage functions for overlapping kinds", async () => {
    const config = {
      ...defaultPhase1GateConfig(),
      stages: [
        { kind: "lint" as const, command: ["sh", "-c", "exit 0"] },
        { kind: "full_tests" as const, command: ["sh", "-c", "exit 0"] },
        { kind: "contract_diff" as const },
      ],
    };

    const affected = resolveStagesForTier({ ...config, tier: "affected" });
    const full = resolveStagesForTier({ ...config, tier: "full" });
    expect(affected.map((stage) => stage.kind)).not.toContain("full_tests");
    expect(full.map((stage) => stage.kind)).toContain("full_tests");

    const runCommand = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const base = {
      gateRunId: must(GateRunId("gate-tier-1")),
      lineageId: must(LineageId("lineage-tier-1")),
      worktreeRoot: ".",
      config,
    };

    const affectedReport = await runGateForTier(base, "affected", "pre", { runCommand });
    const fullReport = await runGateForTier(
      { ...base, gateRunId: must(GateRunId("gate-tier-2")) },
      "full",
      "pre",
      { runCommand },
    );

    const affectedLint = affectedReport.checks.find((check) => check.kind === "lint");
    const fullLint = fullReport.checks.find((check) => check.kind === "lint");
    expect(affectedLint?.status).toBe(fullLint?.status);

    expect(
      TIER_AFFECTED_KINDS.every(
        (kind, index, arr) =>
          index === 0 || compareCheckKind(arr[index - 1] as GateCheckKind, kind) <= 0,
      ),
    ).toBe(true);
    expect(TIER_FULL_KINDS).toContain("contract_diff");
  });
});

describe("W7 — oracle freeze (D7)", () => {
  test("blocks oracle mutation in lib grant evaluation", () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-oracle-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests/oracle.test.ts"), "frozen", "utf8");
    const freeze = must(buildOracleFreezeRecord(root, ["tests/oracle.test.ts"], Date.now()));
    must(saveOracleFreezeRecord(root, ".orchestrator/oracle-freeze.json", freeze));

    const scope = must(makeWriteScope([must(parseRepoPath("tests"))]));
    const denial = evaluateToolCallUnderGrant(
      scope,
      "write",
      { path: "tests/oracle.test.ts", content: "tamper" },
      root,
      freeze,
    );
    expect(denial?.kind).toBe("oracle_denied");
    expect(checkOracleMutationAllowed(freeze, "write", "tests/oracle.test.ts")?.kind).toBe(
      "oracle_denied",
    );

    rmSync(root, { recursive: true, force: true });
  });
});
