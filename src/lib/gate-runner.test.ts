import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canStartFromPre, gateOutcome, gatePassed } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { defaultPhase1GateConfig, loadGateConfig } from "./gate-config";
import {
  type GateCommandResult,
  type RunGateCommand,
  requireGreenPreGate,
  runDeterministicGate,
  runPostGate,
  runPreGate,
} from "./gate-runner";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ids = {
  gateRunId: must(GateRunId("gate-w5-1")),
  lineageId: must(LineageId("lineage-w5-1")),
};

const config = defaultPhase1GateConfig();

const writeMinimalWorktree = (root: string, checkScript: string): void => {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { check: checkScript },
    }),
  );
};

describe("gate config", () => {
  test("loads check script from package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-gate-cfg-"));
    writeMinimalWorktree(root, "exit 0");

    const loaded = must(loadGateConfig(root));
    expect(loaded.command).toEqual(["bun", "run", "check"]);
    expect(loaded.checkKind).toBe("full_tests");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("W5 — deterministic gate PRE and POST (D8)", () => {
  let worktreeRoot: string;

  afterEach(() => {
    if (worktreeRoot) {
      rmSync(worktreeRoot, { recursive: true, force: true });
      worktreeRoot = "";
    }
  });

  test("refuses to start on a non-green PRE state", async () => {
    worktreeRoot = mkdtempSync(join(tmpdir(), "orchestrator-gate-pre-"));
    writeMinimalWorktree(worktreeRoot, "exit 1");

    const pre = await runPreGate({
      ...ids,
      worktreeRoot,
      config,
    });

    expect(pre.phase).toBe("pre");
    expect(gatePassed(pre)).toBe(false);
    expect(canStartFromPre(pre)).toBe(false);

    const allowed = requireGreenPreGate(pre);
    expect(allowed.ok).toBe(false);
    if (allowed.ok) throw new Error("expected PRE refusal");
    expect(allowed.error.kind).toBe("pre_gate_red");
  });

  test("PRE and POST invoke the same gate command through one shared code path", async () => {
    worktreeRoot = mkdtempSync(join(tmpdir(), "orchestrator-gate-shared-"));
    writeMinimalWorktree(worktreeRoot, "exit 0");

    const invocations: Array<{ phase: string; command: readonly string[] }> = [];
    const runCommand: RunGateCommand = async (root, command) => {
      invocations.push({ phase: invocations.length === 0 ? "pre" : "post", command });
      expect(root).toBe(worktreeRoot);
      const result: GateCommandResult = { exitCode: 0, stdout: "", stderr: "" };
      return result;
    };

    const pre = await runPreGate(
      { ...ids, gateRunId: must(GateRunId("gate-pre")), worktreeRoot, config },
      { runCommand },
    );
    const post = await runPostGate(
      { ...ids, gateRunId: must(GateRunId("gate-post")), worktreeRoot, config },
      { runCommand },
    );

    expect(pre.phase).toBe("pre");
    expect(post.phase).toBe("post");
    expect(gateOutcome(pre)).toBe("green");
    expect(gateOutcome(post)).toBe("green");
    expect(invocations).toEqual([
      { phase: "pre", command: config.command },
      { phase: "post", command: config.command },
    ]);

    const direct = await runDeterministicGate(
      { ...ids, gateRunId: must(GateRunId("gate-direct")), phase: "post", worktreeRoot, config },
      { runCommand },
    );
    expect(direct.checks[0]?.status).toBe("passed");
    expect(invocations.at(-1)?.command).toEqual(config.command);
  });

  test("runs the identical check POST-apply and surfaces failure", async () => {
    worktreeRoot = mkdtempSync(join(tmpdir(), "orchestrator-gate-post-"));
    writeMinimalWorktree(worktreeRoot, "exit 0");

    let shouldFail = false;
    const runCommand: RunGateCommand = async () => ({
      exitCode: shouldFail ? 1 : 0,
      stdout: "",
      stderr: shouldFail ? "post-apply regression" : "",
    });

    const pre = await runPreGate({ ...ids, worktreeRoot, config }, { runCommand });
    expect(gatePassed(pre)).toBe(true);

    shouldFail = true;
    const post = await runPostGate(
      { ...ids, gateRunId: must(GateRunId("gate-post-red")), worktreeRoot, config },
      { runCommand },
    );

    expect(post.phase).toBe("post");
    expect(gateOutcome(post)).toBe("red");
    expect(post.checks[0]?.detail).toContain("post-apply regression");
  });
});
