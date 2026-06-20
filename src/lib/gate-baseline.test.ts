import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatePassed } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import {
  captureGateBaseline,
  hasRegressionFromBaseline,
  loadGateBaseline,
  saveGateBaseline,
} from "./gate-baseline";
import { defaultPhase1GateConfig } from "./gate-config";
import { requireGreenPreGate, runPreGate } from "./gate-runner";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("S2/W5 — characterization baseline (D16)", () => {
  test("baseline hash recomputes from stored inputs", () => {
    const report = {
      gateRunId: must(GateRunId("gate-base-1")),
      lineageId: must(LineageId("lineage-base-1")),
      phase: "pre" as const,
      ranAt: must(parseTimestamp(1)),
      checks: [{ kind: "lint" as const, status: "failed" as const, detail: "lint red" }],
    };
    const baseline = captureGateBaseline(report);
    expect(baseline.failedCheckKeys).toEqual(["lint:lint red"]);
    expect(baseline.hash.length).toBeGreaterThan(0);

    const root = mkdtempSync(join(tmpdir(), "orchestrator-base-hash-"));
    saveGateBaseline(root, ".snaffle/gate-baseline.json", baseline);
    const loaded = must(loadGateBaseline(root, ".snaffle/gate-baseline.json"));
    expect(loaded?.hash).toBe(baseline.hash);
    rmSync(root, { recursive: true, force: true });
  });

  test("passes when failures match baseline; fails on new red", () => {
    const baselineReport = {
      gateRunId: must(GateRunId("gate-base-2")),
      lineageId: must(LineageId("lineage-base-2")),
      phase: "pre" as const,
      ranAt: must(parseTimestamp(2)),
      checks: [{ kind: "lint" as const, status: "failed" as const, detail: "known lint" }],
    };
    const baseline = captureGateBaseline(baselineReport);

    const sameRed = {
      ...baselineReport,
      checks: [{ kind: "lint" as const, status: "failed" as const, detail: "known lint" }],
    };
    expect(hasRegressionFromBaseline(sameRed, baseline)).toBe(false);

    const newRed = {
      ...baselineReport,
      checks: [
        { kind: "lint" as const, status: "failed" as const, detail: "known lint" },
        { kind: "types" as const, status: "failed" as const, detail: "new types failure" },
      ],
    };
    expect(hasRegressionFromBaseline(newRed, baseline)).toBe(true);
  });

  test("wrap mode PRE allows known-red tree and blocks regression", async () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-wrap-"));
    const rel = ".snaffle/gate-baseline.json";
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { check: "exit 0" } }),
      "utf8",
    );

    const config = {
      ...defaultPhase1GateConfig(),
      repoMode: "wrap" as const,
      stages: [{ kind: "full_tests" as const, command: ["sh", "-c", "exit 1"] }],
    };

    let fail = true;
    const runCommand = async () => ({
      exitCode: fail ? 1 : 0,
      stdout: "",
      stderr: fail ? "known lint failure" : "",
    });

    const preRed = await runPreGate(
      {
        gateRunId: must(GateRunId("gate-wrap-pre")),
        lineageId: must(LineageId("lineage-wrap")),
        worktreeRoot: root,
        config,
      },
      { runCommand },
    );

    saveGateBaseline(root, rel, captureGateBaseline(preRed));
    expect(requireGreenPreGate(preRed, config, root).ok).toBe(true);

    fail = true;
    const preRegression = await runPreGate(
      {
        gateRunId: must(GateRunId("gate-wrap-pre-2")),
        lineageId: must(LineageId("lineage-wrap")),
        worktreeRoot: root,
        config: {
          ...config,
          stages: [{ kind: "full_tests" as const, command: ["sh", "-c", "exit 1"] }],
        },
      },
      {
        runCommand: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "brand new failure",
        }),
      },
    );

    expect(gatePassed(preRegression)).toBe(false);
    expect(requireGreenPreGate(preRegression, config, root).ok).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});
