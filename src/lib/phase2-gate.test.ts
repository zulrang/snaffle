import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GateCheckKind } from "../domain/gate";
import { compareCheckKind, gateOutcome } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { createOracleProtectionExtension } from "../extensions/oracle-protection";
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
  runPreGate,
} from "./gate-runner";
import {
  buildOracleFreezeRecord,
  checkOracleMutationAllowed,
  type OracleFreezeRecord,
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
  const oracleFreezeRel = ".snaffle/oracle-freeze.json";

  const writeEvent = (path: string): ToolCallEvent => ({
    type: "tool_call",
    toolCallId: "tc-oracle-1",
    toolName: "write",
    input: { path, content: "tamper" },
  });

  const installOracleExtensionHandler = (root: string, freeze: OracleFreezeRecord) => {
    const scope = must(makeWriteScope([must(parseRepoPath("tests"))]));
    let handler:
      | ((event: ToolCallEvent) => Promise<{ block?: boolean; reason?: string } | undefined>)
      | undefined;
    const pi = {
      on: (event: string, h: typeof handler) => {
        if (event === "tool_call") handler = h;
      },
    } as ExtensionAPI;

    createOracleProtectionExtension(scope, freeze, root)(pi);
    if (!handler) throw new Error("oracle protection extension did not register a handler");
    return handler;
  };

  test("blocks oracle mutation in lib grant evaluation", () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-oracle-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests/oracle.test.ts"), "frozen", "utf8");
    const freeze = must(buildOracleFreezeRecord(root, ["tests/oracle.test.ts"], Date.now()));
    must(saveOracleFreezeRecord(root, oracleFreezeRel, freeze));

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

  test("oracle_integrity gate stage is red when oracle file hash drifts", async () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-oracle-stage-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests/oracle.test.ts"), "frozen v1", "utf8");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { check: "exit 0" } }),
      "utf8",
    );

    const freeze = must(buildOracleFreezeRecord(root, ["tests/oracle.test.ts"], Date.now()));
    must(saveOracleFreezeRecord(root, oracleFreezeRel, freeze));

    const config = {
      ...defaultPhase1GateConfig(),
      stages: [{ kind: "oracle_integrity" as const }],
      oracleFreezeRel,
    };

    const preIntact = await runPreGate({
      gateRunId: must(GateRunId("gate-oracle-intact")),
      lineageId: must(LineageId("lineage-oracle")),
      worktreeRoot: root,
      config,
    });
    expect(preIntact.checks[0]).toEqual({ kind: "oracle_integrity", status: "passed" });

    writeFileSync(join(root, "tests/oracle.test.ts"), "tampered", "utf8");
    const preDrifted = await runPreGate({
      gateRunId: must(GateRunId("gate-oracle-drift")),
      lineageId: must(LineageId("lineage-oracle")),
      worktreeRoot: root,
      config,
    });
    expect(preDrifted.checks[0]?.kind).toBe("oracle_integrity");
    expect(preDrifted.checks[0]?.status).toBe("failed");
    expect(preDrifted.checks[0]?.detail).toContain("oracle touched: tests/oracle.test.ts");

    rmSync(root, { recursive: true, force: true });
  });

  test("Pi oracle extension blocks frozen oracle writes via the same lib rule", async () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-oracle-ext-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests/oracle.test.ts"), "frozen", "utf8");
    const freeze = must(buildOracleFreezeRecord(root, ["tests/oracle.test.ts"], Date.now()));
    const handler = installOracleExtensionHandler(root, freeze);

    const blocked = await handler(writeEvent("tests/oracle.test.ts"));
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("frozen and read-only");

    const allowed = await handler(writeEvent("tests/helper.ts"));
    expect(allowed).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });
});
