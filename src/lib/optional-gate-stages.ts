import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectGateConfig } from "./gate-config";
import { SKELETON_GATE_FIXTURE_REL, skeletonGateConfig } from "./skeleton-gate-fixture";

/**
 * Optional gate stages (W7): spec_traceability + smoke_budget command fixtures.
 * Disabled in skeletonGateConfig; enable via gateConfigWithOptionalStages().
 */

export const SPEC_TRACEABILITY_FIXTURE_REL = "src/lib/w7-spec-traceability.test.ts";
export const SMOKE_BUDGET_FIXTURE_REL = "src/lib/w7-smoke-budget.test.ts";

const bunTest = (body: string): string =>
  ['import { describe, expect, test } from "bun:test";', body, ""].join("\n");

const fixtureSource = (pass: boolean): string =>
  bunTest(
    [
      'describe("w7 optional gate stage", () => {',
      `  test("${pass ? "passes" : "fails"}", () => { expect(1).toBe(${pass ? 1 : 2}); });`,
      "});",
    ].join("\n"),
  );

export const writeOptionalGateStageFixtures = (
  worktreeRoot: string,
  mode: "pass" | "fail",
): void => {
  const pass = mode === "pass";
  for (const rel of [SPEC_TRACEABILITY_FIXTURE_REL, SMOKE_BUDGET_FIXTURE_REL]) {
    const path = join(worktreeRoot, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fixtureSource(pass), "utf8");
  }
};

/** ponytail: optional stages prepend the skeleton full_tests stage; off by default. */
export const gateConfigWithOptionalStages = (): ProjectGateConfig => {
  const base = skeletonGateConfig();
  return {
    ...base,
    stages: [
      {
        kind: "spec_traceability",
        command: ["bun", "test", SPEC_TRACEABILITY_FIXTURE_REL],
      },
      {
        kind: "smoke_budget",
        command: ["bun", "test", SMOKE_BUDGET_FIXTURE_REL],
      },
      { kind: "full_tests", command: ["bun", "test", SKELETON_GATE_FIXTURE_REL] },
    ],
  };
};
