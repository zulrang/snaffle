import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBudget, createBudgetGovernor, recordTokenSpend } from "../lib/budget-governor";
import { BUDGET_DB_FILE, loadBudgetGovernor, persistBudgetGovernor } from "../lib/budget-ledger";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";

/**
 * P7/S4 — durable budget ledger spike.
 */

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("P7/S4 — budget ledger spike", () => {
  test("counters survive reopen when persistence enabled", () => {
    const workspace = mkdtempSync(join(tmpdir(), "p7-s4-"));
    try {
      const dbPath = join(workspace, BUDGET_DB_FILE);
      const state = recordTokenSpend(createBudgetGovernor(), 42);
      must(persistBudgetGovernor(dbPath, "ws", true, state));
      expect(loadBudgetGovernor(dbPath, "ws", true).counters.sessionSpent).toBe(42);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("kill-switch trips after reload", () => {
    const workspace = mkdtempSync(join(tmpdir(), "p7-s4-kill-"));
    try {
      const dbPath = join(workspace, BUDGET_DB_FILE);
      const limits = defaultOrchestratorConfig().budget;
      const state = recordTokenSpend(createBudgetGovernor(), limits.killSwitchTokens);
      must(persistBudgetGovernor(dbPath, "ws", true, state));
      const reloaded = loadBudgetGovernor(dbPath, "ws", true);
      expect(checkBudget(reloaded, limits).kind).toBe("kill");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
