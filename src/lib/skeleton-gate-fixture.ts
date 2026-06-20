import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectGateConfig } from "./gate-config";
import { PHASE1_GATE_CHECK_KIND } from "./gate-config";

/**
 * Non-recursive gate fixture for skeleton/worktree integration (W5/W8).
 *
 * ponytail: single static test file — upgrade path is project-configured gate kinds.
 */

export const SKELETON_GATE_FIXTURE_REL = "src/lib/w8-gate-fixture.test.ts";

const passingFixtureSource = (): string =>
  [
    'import { describe, expect, test } from "bun:test";',
    'describe("w8 gate fixture", () => {',
    '  test("passes", () => { expect(1).toBe(1); });',
    "});",
    "",
  ].join("\n");

const failingFixtureSource = (): string =>
  [
    'import { describe, expect, test } from "bun:test";',
    'describe("w8 gate fixture", () => {',
    '  test("fails post-apply", () => { expect(1).toBe(2); });',
    "});",
    "",
  ].join("\n");

export const writePassingGateFixture = (worktreeRoot: string): void => {
  writeFileSync(join(worktreeRoot, SKELETON_GATE_FIXTURE_REL), passingFixtureSource(), "utf8");
};

export const writeFailingGateFixture = (worktreeRoot: string): void => {
  writeFileSync(join(worktreeRoot, SKELETON_GATE_FIXTURE_REL), failingFixtureSource(), "utf8");
};

export const skeletonGateConfig = (): ProjectGateConfig => ({
  tier: "full",
  repoMode: "strict",
  stages: [{ kind: PHASE1_GATE_CHECK_KIND, command: ["bun", "test", SKELETON_GATE_FIXTURE_REL] }],
  contractPaths: [],
  contractBaselineRel: ".snaffle/contract-baseline.json",
  gateBaselineRel: ".snaffle/gate-baseline.json",
  oracleFreezeRel: ".snaffle/oracle-freeze.json",
});
