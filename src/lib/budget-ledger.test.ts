import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBudgetCheck,
  checkBudget,
  createBudgetGovernor,
  recordTokenSpend,
} from "./budget-governor";
import {
  BUDGET_DB_FILE,
  loadBudgetGovernor,
  openBudgetLedger,
  persistBudgetGovernor,
} from "./budget-ledger";
import { defaultOrchestratorConfig } from "./orchestrator-config";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W4 — durable budget ledger (D22)", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("counters survive store reopen when persistence is enabled", () => {
    workspace = mkdtempSync(join(tmpdir(), "w4-budget-"));
    const dbPath = join(workspace, BUDGET_DB_FILE);
    const workspaceId = "ws-1";

    let state = recordTokenSpend(createBudgetGovernor(), 5000);
    must(persistBudgetGovernor(dbPath, workspaceId, true, state));

    const reloaded = loadBudgetGovernor(dbPath, workspaceId, true);
    expect(reloaded.counters.rollingWindowSpent).toBe(5000);

    state = recordTokenSpend(reloaded, 1000);
    must(persistBudgetGovernor(dbPath, workspaceId, true, state));
    expect(loadBudgetGovernor(dbPath, workspaceId, true).counters.sessionSpent).toBe(6000);
  });

  test("kill-switch still trips after reload", () => {
    workspace = mkdtempSync(join(tmpdir(), "w4-kill-"));
    const dbPath = join(workspace, BUDGET_DB_FILE);
    const limits = defaultOrchestratorConfig().budget;
    const spent = limits.killSwitchTokens;
    const state = recordTokenSpend(createBudgetGovernor(), spent);
    must(persistBudgetGovernor(dbPath, "ws-kill", true, state));

    const reloaded = loadBudgetGovernor(dbPath, "ws-kill", true);
    expect(checkBudget(reloaded, limits).kind).toBe("kill");
  });

  test("persistence disabled is a no-op load/save", () => {
    workspace = mkdtempSync(join(tmpdir(), "w4-off-"));
    const dbPath = join(workspace, BUDGET_DB_FILE);
    const fresh = loadBudgetGovernor(dbPath, "ws-off", false);
    expect(fresh).toEqual(createBudgetGovernor());
    must(persistBudgetGovernor(dbPath, "ws-off", false, recordTokenSpend(fresh, 999)));
    const store = openBudgetLedger(dbPath);
    expect(must(store.load("ws-off"))).toBeUndefined();
    store.close();
  });

  test("budget pause survives reload", () => {
    workspace = mkdtempSync(join(tmpdir(), "w4-pause-"));
    const dbPath = join(workspace, BUDGET_DB_FILE);
    const limits = defaultOrchestratorConfig().budget;
    const state = applyBudgetCheck(
      recordTokenSpend(createBudgetGovernor(), limits.perChangeTokens),
      limits,
    );
    expect(state.paused).toBe(true);
    must(persistBudgetGovernor(dbPath, "ws-pause", true, state));
    const reloaded = loadBudgetGovernor(dbPath, "ws-pause", true);
    expect(reloaded.pauseSource).toBe("budget");
  });
});
