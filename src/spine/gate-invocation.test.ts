import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateOutcome, gatePassed } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { PHASE1_GATE_CHECK_KIND } from "../lib/gate-config";
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

const ids = {
  gateRunId: must(GateRunId("gate-w5-wt-pre")),
  lineageId: must(LineageId("lineage-w5-wt")),
};

/** Non-recursive gate command — `bun run check` would re-enter this integration suite. */
const worktreeGateConfig = (worktreeRoot: string) => {
  writeFileSync(
    join(worktreeRoot, gateFixtureRel),
    [
      'import { describe, expect, test } from "bun:test";',
      'describe("w5 gate fixture", () => {',
      '  test("passes", () => { expect(1).toBe(1); });',
      "});",
      "",
    ].join("\n"),
  );

  return {
    command: ["bun", "test", gateFixtureRel],
    checkKind: PHASE1_GATE_CHECK_KIND,
  } as const;
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
