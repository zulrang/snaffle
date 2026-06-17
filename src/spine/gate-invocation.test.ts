import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GateReport, gateOutcome, gatePassed } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { PHASE1_GATE_CHECK_KIND } from "../lib/gate-config";
import { GATE_DETERMINISTIC_ENTRY, type GateRunTrace } from "../lib/gate-runner";
import {
  prepareWorktreeGate,
  runPostGateInWorktree,
  runPreGateInWorktree,
} from "./gate-invocation";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");
const gateFixtureRel = "src/lib/w5-gate-fixture.test.ts";
const trivialChangeRel = "src/lib/w5-trivial-change.ts";

const ids = {
  gateRunId: must(GateRunId("gate-w5-wt-pre")),
  lineageId: must(LineageId("lineage-w5-wt")),
};

const passingFixtureSource = (): string =>
  [
    'import { describe, expect, test } from "bun:test";',
    'describe("w5 gate fixture", () => {',
    '  test("passes", () => { expect(1).toBe(1); });',
    "});",
    "",
  ].join("\n");

const failingFixtureSource = (): string =>
  [
    'import { describe, expect, test } from "bun:test";',
    'describe("w5 gate fixture", () => {',
    '  test("fails pre", () => { expect(1).toBe(2); });',
    "});",
    "",
  ].join("\n");

const writeGateFixture = (worktreeRoot: string, source: string): void => {
  writeFileSync(join(worktreeRoot, gateFixtureRel), source, "utf8");
};

/** Non-recursive gate command — `bun run check` would re-enter this integration suite. */
const worktreeGateConfig = (worktreeRoot: string) => {
  writeGateFixture(worktreeRoot, passingFixtureSource());

  return {
    command: ["bun", "test", gateFixtureRel],
    checkKind: PHASE1_GATE_CHECK_KIND,
  } as const;
};

/** Outcome fields stable across repeated runs (temp-0 gate: same tree → same verdict). */
const gateFingerprint = (report: GateReport) => ({
  phase: report.phase,
  outcome: gateOutcome(report),
  checks: report.checks.map((check) => ({
    kind: check.kind,
    status: check.status,
  })),
});

const applyTrivialChange = (worktreeRoot: string): void => {
  writeFileSync(join(worktreeRoot, trivialChangeRel), "// w5 trivial\n", "utf8");
};

describe("W5 — gate in isolated worktree (integration)", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (dispose) {
      await dispose();
      dispose = undefined;
    }
  });

  test("PRE is green on a clean detached worktree", async () => {
    const prepared = must(await prepareWorktreeGate(repoRoot));
    dispose = prepared.dispose;

    const context = {
      worktreeRoot: prepared.worktreeRoot,
      config: worktreeGateConfig(prepared.worktreeRoot),
    };

    const pre = must(await runPreGateInWorktree(context, ids));
    expect(pre.phase).toBe("pre");
    expect(gatePassed(pre)).toBe(true);
  }, 60_000);

  test("POST runs the same check after a breaking apply", async () => {
    const prepared = must(await prepareWorktreeGate(repoRoot));
    dispose = prepared.dispose;

    const context = {
      worktreeRoot: prepared.worktreeRoot,
      config: worktreeGateConfig(prepared.worktreeRoot),
    };

    const pre = must(await runPreGateInWorktree(context, ids));
    expect(gatePassed(pre)).toBe(true);

    writeFileSync(
      join(prepared.worktreeRoot, gateFixtureRel),
      [
        'import { describe, expect, test } from "bun:test";',
        'describe("w5 gate fixture", () => {',
        '  test("fails post-apply", () => { expect(1).toBe(2); });',
        "});",
        "",
      ].join("\n"),
    );

    const post = await runPostGateInWorktree(context, {
      gateRunId: must(GateRunId("gate-w5-wt-post")),
      lineageId: ids.lineageId,
    });

    expect(post.phase).toBe("post");
    expect(gateOutcome(post)).toBe("red");
  }, 60_000);
});

describe("D8/D12 — PRE/POST gate identity in worktree", () => {
  const runTrivialGateCycle = async (
    traces: GateRunTrace[],
  ): Promise<{ pre: GateReport; post: GateReport }> => {
    const prepared = must(await prepareWorktreeGate(repoRoot));
    try {
      const config = worktreeGateConfig(prepared.worktreeRoot);
      const context = { worktreeRoot: prepared.worktreeRoot, config };
      const runnerOptions = {
        onTrace: (trace: GateRunTrace) => {
          traces.push(trace);
        },
      };

      const pre = must(await runPreGateInWorktree(context, ids, runnerOptions));
      applyTrivialChange(prepared.worktreeRoot);
      const post = await runPostGateInWorktree(
        context,
        {
          gateRunId: must(GateRunId("gate-w5-wt-post")),
          lineageId: ids.lineageId,
        },
        runnerOptions,
      );

      return { pre, post };
    } finally {
      await prepared.dispose();
    }
  };

  test("refuses to start on a deliberately red tree, then proceeds once greened", async () => {
    const prepared = must(await prepareWorktreeGate(repoRoot));
    try {
      writeGateFixture(prepared.worktreeRoot, failingFixtureSource());
      const config = {
        command: ["bun", "test", gateFixtureRel],
        checkKind: PHASE1_GATE_CHECK_KIND,
      } as const;
      const context = { worktreeRoot: prepared.worktreeRoot, config };

      const blocked = await runPreGateInWorktree(context, ids);
      expect(blocked.ok).toBe(false);
      if (blocked.ok) throw new Error("expected PRE refusal on red tree");
      expect(blocked.error.kind).toBe("pre_gate_red");
      expect(gatePassed(blocked.error.report)).toBe(false);

      writeGateFixture(prepared.worktreeRoot, passingFixtureSource());
      const pre = must(await runPreGateInWorktree(context, ids));
      expect(gatePassed(pre)).toBe(true);

      applyTrivialChange(prepared.worktreeRoot);
      const post = await runPostGateInWorktree(context, {
        gateRunId: must(GateRunId("gate-w5-wt-post-green")),
        lineageId: ids.lineageId,
      });
      expect(gatePassed(post)).toBe(true);
    } finally {
      await prepared.dispose();
    }
  }, 60_000);

  test("identical trivial change run twice yields identical gate outcomes", async () => {
    const tracesA: GateRunTrace[] = [];
    const tracesB: GateRunTrace[] = [];

    const runA = await runTrivialGateCycle(tracesA);
    const runB = await runTrivialGateCycle(tracesB);

    expect(gateFingerprint(runA.pre)).toEqual(gateFingerprint(runB.pre));
    expect(gateFingerprint(runA.post)).toEqual(gateFingerprint(runB.post));
  }, 120_000);

  test("PRE and POST traces show the same deterministic gate entry and command (D12)", async () => {
    const traces: GateRunTrace[] = [];
    await runTrivialGateCycle(traces);

    expect(traces).toHaveLength(2);
    expect(traces.every((trace) => trace.entry === GATE_DETERMINISTIC_ENTRY)).toBe(true);
    expect(traces[0]?.phase).toBe("pre");
    expect(traces[1]?.phase).toBe("post");
    expect(traces[0]?.command).toEqual(traces[1]?.command);
    expect(traces[0]?.command).toEqual(["bun", "test", gateFixtureRel]);
  }, 60_000);
});
