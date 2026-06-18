import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateOutcome } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { runDeterministicGate } from "./gate-runner";
import {
  gateConfigWithOptionalStages,
  writeOptionalGateStageFixtures,
} from "./optional-gate-stages";
import { writePassingGateFixture } from "./skeleton-gate-fixture";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W7 — optional gate stages (spec_traceability, smoke_budget)", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("passing fixtures run green when stages are enabled", async () => {
    workspace = mkdtempSync(join(tmpdir(), "w7-stages-pass-"));
    writeOptionalGateStageFixtures(workspace, "pass");
    writePassingGateFixture(workspace);

    const report = await runDeterministicGate({
      gateRunId: must(GateRunId("gate-w7-pass")),
      lineageId: must(LineageId("L-w7-pass")),
      phase: "pre",
      worktreeRoot: workspace,
      config: gateConfigWithOptionalStages(),
    });

    expect(gateOutcome(report)).toBe("green");
    expect(report.checks.map((c) => c.kind)).toEqual([
      "spec_traceability",
      "smoke_budget",
      "full_tests",
    ]);
  });

  test("failing spec_traceability fixture stops the gate red", async () => {
    workspace = mkdtempSync(join(tmpdir(), "w7-stages-red-"));
    writeOptionalGateStageFixtures(workspace, "fail");
    writePassingGateFixture(workspace);

    const report = await runDeterministicGate({
      gateRunId: must(GateRunId("gate-w7-red")),
      lineageId: must(LineageId("L-w7-red")),
      phase: "pre",
      worktreeRoot: workspace,
      config: gateConfigWithOptionalStages(),
    });

    expect(gateOutcome(report)).toBe("red");
    expect(report.checks[0]?.kind).toBe("spec_traceability");
    expect(report.checks[0]?.status).toBe("failed");
  });

  test("skeleton gate config omits optional stages by default", async () => {
    workspace = mkdtempSync(join(tmpdir(), "w7-stages-off-"));
    writeOptionalGateStageFixtures(workspace, "fail");
    writePassingGateFixture(workspace);

    const { skeletonGateConfig } = await import("./skeleton-gate-fixture");
    const report = await runDeterministicGate({
      gateRunId: must(GateRunId("gate-w7-off")),
      lineageId: must(LineageId("L-w7-off")),
      phase: "pre",
      worktreeRoot: workspace,
      config: skeletonGateConfig(),
    });

    expect(gateOutcome(report)).toBe("green");
    expect(report.checks.some((c) => c.kind === "spec_traceability")).toBe(false);
    expect(report.checks.some((c) => c.kind === "smoke_budget")).toBe(false);
  });
});
