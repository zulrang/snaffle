import { err, ok, type Result } from "../domain/shared";
import type { BudgetGovernorState } from "./budget-governor";
import { createBudgetGovernor } from "./budget-governor";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

/**
 * Durable budget ledger (D22, W4/W11). Optional SQLite persistence for budget counters;
 * in-memory governor remains default when disabled.
 */

export const BUDGET_DB_DIR = ".snaffle";
export const BUDGET_DB_FILE = "budget.sqlite";

export type BudgetLedgerError =
  | { readonly kind: "database_error"; readonly detail: string }
  | { readonly kind: "invalid_row"; readonly detail: string };

export interface BudgetLedgerStore {
  readonly dbPath: string;
  load(workspaceId: string): Result<BudgetGovernorState | undefined, BudgetLedgerError>;
  save(workspaceId: string, state: BudgetGovernorState): Result<void, BudgetLedgerError>;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_state (
  workspace_id TEXT PRIMARY KEY,
  rolling_window_spent INTEGER NOT NULL,
  session_spent INTEGER NOT NULL,
  per_change_spent INTEGER NOT NULL,
  paused INTEGER NOT NULL,
  pause_source TEXT
);
`;

interface BudgetRow {
  readonly rolling_window_spent: unknown;
  readonly session_spent: unknown;
  readonly per_change_spent: unknown;
  readonly paused: unknown;
  readonly pause_source: unknown;
}

const parseRow = (row: BudgetRow): BudgetGovernorState | undefined => {
  if (
    typeof row.rolling_window_spent !== "number" ||
    typeof row.session_spent !== "number" ||
    typeof row.per_change_spent !== "number" ||
    typeof row.paused !== "number"
  ) {
    return undefined;
  }
  const pauseSource =
    row.pause_source === "budget" || row.pause_source === "operator" ? row.pause_source : undefined;
  return {
    counters: {
      rollingWindowSpent: row.rolling_window_spent,
      sessionSpent: row.session_spent,
      perChangeSpent: row.per_change_spent,
    },
    paused: row.paused === 1,
    ...(pauseSource === undefined ? {} : { pauseSource }),
  };
};

export const openBudgetLedger = (dbPath: string): BudgetLedgerStore => {
  const db: SqliteDatabase = openSqliteDatabase(dbPath);
  db.exec(SCHEMA);

  const load = (
    workspaceId: string,
  ): Result<BudgetGovernorState | undefined, BudgetLedgerError> => {
    try {
      const row = db
        .prepare("SELECT * FROM budget_state WHERE workspace_id = ?")
        .get(workspaceId) as BudgetRow | undefined | null;
      if (row === undefined || row === null) return ok(undefined);
      const parsed = parseRow(row);
      if (parsed === undefined) {
        return err({ kind: "invalid_row", detail: workspaceId });
      }
      return ok(parsed);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const save = (
    workspaceId: string,
    state: BudgetGovernorState,
  ): Result<void, BudgetLedgerError> => {
    try {
      db.prepare(
        `INSERT INTO budget_state (
          workspace_id, rolling_window_spent, session_spent, per_change_spent, paused, pause_source
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          rolling_window_spent = excluded.rolling_window_spent,
          session_spent = excluded.session_spent,
          per_change_spent = excluded.per_change_spent,
          paused = excluded.paused,
          pause_source = excluded.pause_source`,
      ).run(
        workspaceId,
        state.counters.rollingWindowSpent,
        state.counters.sessionSpent,
        state.counters.perChangeSpent,
        state.paused ? 1 : 0,
        state.pauseSource ?? null,
      );
      return ok(undefined);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return { dbPath, load, save, close: () => db.close() };
};

export const loadBudgetGovernor = (
  dbPath: string,
  workspaceId: string,
  persist: boolean,
): BudgetGovernorState => {
  if (!persist) return createBudgetGovernor();
  const store = openBudgetLedger(dbPath);
  try {
    const loaded = store.load(workspaceId);
    if (!loaded.ok || loaded.value === undefined) return createBudgetGovernor();
    return loaded.value;
  } finally {
    store.close();
  }
};

export const persistBudgetGovernor = (
  dbPath: string,
  workspaceId: string,
  persist: boolean,
  state: BudgetGovernorState,
): Result<void, BudgetLedgerError> => {
  if (!persist) return ok(undefined);
  const store = openBudgetLedger(dbPath);
  try {
    return store.save(workspaceId, state);
  } finally {
    store.close();
  }
};
