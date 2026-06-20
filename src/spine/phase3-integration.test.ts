import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTwoWay } from "../domain/door";
import {
  GateRunId,
  GenerationId,
  GrantId,
  InvocationId,
  LineageId,
  RequirementId,
  TransitionId,
} from "../domain/ids";
import { freezeAcceptanceTarget, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import { createBudgetGovernor, pauseByOperator } from "../lib/budget-governor";
import { DEFAULT_GATE_CONFIG_REL } from "../lib/gate-config";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { freezePlanAt } from "../lib/plan-freezer";
import { escalateTier, resolveModelTier } from "../lib/tier-router";
import { invokeStubAgent } from "../pi/invoke-stub-agent";
import { buildDefaultPhase1Lineage } from "./phase1-cli";
import { runSkeletonLineage, type SkeletonRunIds, stepBudget } from "./skeleton-run";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));

const scope = must(
  makeWriteScope([must(parseRepoPath("src/domain")), must(parseRepoPath("src/lib"))]),
);

const lineage = makeLineage({
  lineageId: must(LineageId("lineage-p3")),
  requirementId: must(RequirementId("req-p3")),
  door: classifyTwoWay(),
  acceptanceTarget: must(
    freezeAcceptanceTarget({
      targetHash: must(parseContentHash("c".repeat(64))),
      criteria: [{ id: "c1", statement: "phase 3 spine integration" }],
      frozenAt: ts,
    }),
  ),
  declaredScope: scope,
  createdAt: ts,
});

const idsFor = (suffix: string): SkeletonRunIds => ({
  grantId: must(GrantId(`grant-p3-${suffix}`)),
  invocationId: must(InvocationId(`inv-p3-${suffix}`)),
  generationId: must(GenerationId(`gen-p3-${suffix}`)),
  preGateRunId: must(GateRunId(`gate-p3-${suffix}-pre`)),
  postGateRunId: must(GateRunId(`gate-p3-${suffix}-post`)),
  transitionId: must(TransitionId(`tr-p3-${suffix}`)),
});

const writeGateToml = (root: string, body: string): void => {
  mkdirSync(join(root, ".snaffle"), { recursive: true });
  writeFileSync(join(root, DEFAULT_GATE_CONFIG_REL), body);
};

describe("W9 — stale plan blocks skeleton start", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("config drift after plan freeze refuses the run before any worktree work", async () => {
    root = mkdtempSync(join(tmpdir(), "phase3-stale-"));
    writeGateToml(root, 'tier = "full"\n');
    must(freezePlanAt(root));
    // Mutate the frozen source after freeze — the spine must refuse to start.
    writeGateToml(root, 'tier = "affected"\n');

    const outcome = await runSkeletonLineage({
      repoRoot: root,
      lineage,
      variant: "merge_success",
      ids: idsFor("stale"),
      ownerId: "orchestrator-p3-stale",
      at: ts,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("stale_plan");
  });
});

describe("W2/W9 — door classified from repo gate.toml at admission", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a one-way path pattern in repo config makes the default lineage one-way", () => {
    root = mkdtempSync(join(tmpdir(), "phase3-door-"));
    writeGateToml(root, '[door]\npublic_contract = ["src/lib"]\n');

    const built = must(buildDefaultPhase1Lineage(root));
    expect(built.door.direction).toBe("one_way");
    if (built.door.direction === "one_way") {
      expect(built.door.triggers).toContain("public_contract");
    }
  });

  test("absent door config defaults to a two-way door", () => {
    root = mkdtempSync(join(tmpdir(), "phase3-door2-"));
    const built = must(buildDefaultPhase1Lineage(root));
    expect(built.door.direction).toBe("two_way");
  });
});

describe("W8/W9 — budget evaluated between spine steps", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a runaway spend trips the kill-switch from repo budget config", () => {
    root = mkdtempSync(join(tmpdir(), "phase3-budget-"));
    writeGateToml(root, "[budget]\nkill_switch_tokens = 100\n");

    const stepped = stepBudget(createBudgetGovernor(), root, 133);
    expect(stepped.ok).toBe(false);
    if (stepped.ok) return;
    expect(stepped.error.kind).toBe("budget_paused");
    expect(stepped.error.detail).toBe("kill_switch_tokens");
  });

  test("per-change ceiling pauses the lineage", () => {
    root = mkdtempSync(join(tmpdir(), "phase3-budget2-"));
    writeGateToml(root, "[budget]\nper_change_tokens = 100\n");

    const stepped = stepBudget(createBudgetGovernor(), root, 133);
    expect(stepped.ok).toBe(false);
    if (stepped.ok) return;
    expect(stepped.error.kind).toBe("budget_paused");
  });

  test("an operator pause is not auto-resumed by a clean budget step", () => {
    root = mkdtempSync(join(tmpdir(), "phase3-budget3-"));
    // No budget breach — defaults; operator-held state must stay paused.
    const stepped = stepBudget(pauseByOperator(createBudgetGovernor()), root, 1);
    expect(stepped.ok).toBe(false);
    if (stepped.ok) return;
    expect(stepped.error.detail).toBe("operator");
  });
});

describe("W7 — config-resolved tier flows into invocation metadata (D18)", () => {
  const swapped = {
    ...defaultOrchestratorConfig(),
    tiers: {
      light: { provider: "anthropic", model: "claude-light" },
      mid: { provider: "anthropic", model: "claude-mid" },
      heavy: { provider: "anthropic", model: "claude-heavy" },
    },
  };

  const invokeAtTier = async (tier: "light" | "mid" | "heavy", suffix: string) => {
    const id = must(InvocationId(`inv-tier-${suffix}`));
    const result = must(
      await invokeStubAgent(
        {
          invocationId: id,
          prompt: "Apply a trivial edit",
          targetPath: "src/lib/tier-marker.ts",
          content: "// tier\n",
        },
        { modelRef: resolveModelTier(tier, swapped) },
      ),
    );
    return result.metadata;
  };

  test("stub invocation records the config-resolved model, not the pinned faux stub", async () => {
    const meta = await invokeAtTier("light", "light");
    expect(meta.provider).toBe("anthropic");
    expect(meta.modelId).toBe("claude-light");
  });

  test("escalate_one_tier (light→mid) is reflected in recorded metadata", async () => {
    const nextTier = escalateTier("light");
    expect(nextTier).toBe("mid");
    if (nextTier === null) return;
    const meta = await invokeAtTier(nextTier, "mid");
    expect(meta.provider).toBe("anthropic");
    expect(meta.modelId).toBe("claude-mid");
  });
});
