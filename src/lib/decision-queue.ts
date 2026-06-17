import type { DoorClassification } from "../domain/door";
import { requiresHumanSignOff } from "../domain/door";
import { BatchId, DecisionId, LineageId } from "../domain/ids";
import { err, ok, parseTimestamp, type Result, type Timestamp } from "../domain/shared";
import type { LineageState } from "../domain/transition";
import { applyHumanDecision, type HumanDecision } from "./human-decision";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

/**
 * Batched HITL decision queue (D11, W5). Durable SQLite store for human decisions;
 * enqueue on `awaiting_human` (and related kinds); recordDecision resumes or
 * closes via the control-plane resolver — the queue never mutates state itself.
 */

export const DECISION_DB_DIR = ".orchestrator";
export const DECISION_DB_FILE = "decisions.sqlite";

export type DecisionKind = "merge_hold" | "door_override" | "spike_resolution" | "two_way_sample";

export interface DecisionItem {
  readonly decisionId: DecisionId;
  readonly lineageId: LineageId;
  readonly kind: DecisionKind;
  readonly doorDirection: DoorClassification["direction"];
  readonly batchId?: BatchId;
  readonly enqueuedAt: Timestamp;
  readonly decidedAt?: Timestamp;
  readonly decision?: HumanDecision;
}

export type DecisionQueueError =
  | { readonly kind: "invalid_id"; readonly detail: string }
  | { readonly kind: "duplicate_decision"; readonly decisionId: string }
  | { readonly kind: "not_found"; readonly decisionId: string }
  | { readonly kind: "already_decided"; readonly decisionId: string }
  | { readonly kind: "not_awaiting_human" }
  | { readonly kind: "database_error"; readonly detail: string };

export interface DecisionQueueStore {
  readonly dbPath: string;
  enqueue(input: EnqueueDecisionInput): Result<DecisionItem, DecisionQueueError>;
  recordDecision(input: RecordDecisionInput): Result<RecordDecisionOutcome, DecisionQueueError>;
  pendingCount(): Result<number, DecisionQueueError>;
  listPending(): Result<readonly DecisionItem[], DecisionQueueError>;
  getByLineageId(lineageId: LineageId): Result<DecisionItem | undefined, DecisionQueueError>;
  close(): void;
}

export interface EnqueueDecisionInput {
  readonly decisionId: DecisionId;
  readonly lineageId: LineageId;
  readonly kind: DecisionKind;
  readonly door: DoorClassification;
  readonly enqueuedAt: Timestamp;
  readonly batchId?: BatchId;
}

export interface RecordDecisionInput {
  readonly decisionId: DecisionId;
  readonly decision: HumanDecision;
  readonly currentState: LineageState;
  readonly decidedAt: Timestamp;
}

export interface RecordDecisionOutcome {
  readonly item: DecisionItem;
  readonly nextState: LineageState;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decision_items (
  decision_id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  door_direction TEXT NOT NULL,
  batch_id TEXT,
  enqueued_at INTEGER NOT NULL,
  decided_at INTEGER,
  decision TEXT
);

CREATE INDEX IF NOT EXISTS idx_decision_lineage ON decision_items (lineage_id);
`;

interface DecisionRow {
  readonly decision_id: unknown;
  readonly lineage_id: unknown;
  readonly kind: unknown;
  readonly door_direction: unknown;
  readonly batch_id: unknown;
  readonly enqueued_at: unknown;
  readonly decided_at: unknown;
  readonly decision: unknown;
}

const parseRow = (row: DecisionRow): DecisionItem | undefined => {
  if (
    typeof row.decision_id !== "string" ||
    typeof row.lineage_id !== "string" ||
    typeof row.kind !== "string" ||
    typeof row.door_direction !== "string" ||
    typeof row.enqueued_at !== "number"
  ) {
    return undefined;
  }

  const decisionId = DecisionId(row.decision_id);
  const lineageId = LineageId(row.lineage_id);
  const enqueuedAt = parseTimestamp(row.enqueued_at);
  if (!decisionId.ok || !lineageId.ok || !enqueuedAt.ok) return undefined;

  let batchId: BatchId | undefined;
  if (typeof row.batch_id === "string" && row.batch_id.length > 0) {
    const parsed = BatchId(row.batch_id);
    if (!parsed.ok) return undefined;
    batchId = parsed.value;
  }

  let decidedAt: Timestamp | undefined;
  if (typeof row.decided_at === "number") {
    const parsed = parseTimestamp(row.decided_at);
    if (!parsed.ok) return undefined;
    decidedAt = parsed.value;
  }

  const decision =
    row.decision === "approve" || row.decision === "reject" || row.decision === "override"
      ? row.decision
      : undefined;

  if (row.door_direction !== "one_way" && row.door_direction !== "two_way") return undefined;

  return {
    decisionId: decisionId.value,
    lineageId: lineageId.value,
    kind: row.kind as DecisionKind,
    doorDirection: row.door_direction,
    ...(batchId === undefined ? {} : { batchId }),
    enqueuedAt: enqueuedAt.value,
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(decision === undefined ? {} : { decision }),
  };
};

/** Enqueue when a lineage parks for human sign-off (D11). Idempotent per lineage. */
export const enqueueAwaitingHuman = (
  store: DecisionQueueStore,
  input: Omit<EnqueueDecisionInput, "kind">,
): Result<DecisionItem, DecisionQueueError> => {
  if (!requiresHumanSignOff(input.door)) {
    return err({ kind: "invalid_id", detail: "door does not require human sign-off" });
  }
  return store.enqueue({ ...input, kind: "merge_hold" });
};

export const openDecisionQueueStore = (dbPath: string): DecisionQueueStore => {
  const db: SqliteDatabase = openSqliteDatabase(dbPath);
  db.exec(SCHEMA);

  const getByDecisionId = (decisionId: DecisionId): DecisionItem | undefined => {
    const row = db.prepare("SELECT * FROM decision_items WHERE decision_id = ?").get(decisionId);
    if (row === undefined || row === null) return undefined;
    return parseRow(row as DecisionRow);
  };

  const enqueue = (input: EnqueueDecisionInput): Result<DecisionItem, DecisionQueueError> => {
    const existing = db
      .prepare("SELECT * FROM decision_items WHERE lineage_id = ?")
      .get(input.lineageId);
    if (existing !== undefined && existing !== null) {
      const parsed = parseRow(existing as DecisionRow);
      if (parsed !== undefined) return ok(parsed);
    }

    try {
      db.prepare(
        `INSERT INTO decision_items (
          decision_id, lineage_id, kind, door_direction, batch_id, enqueued_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.decisionId,
        input.lineageId,
        input.kind,
        input.door.direction,
        input.batchId ?? null,
        input.enqueuedAt,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes("UNIQUE constraint failed")) {
        const again = db
          .prepare("SELECT * FROM decision_items WHERE lineage_id = ?")
          .get(input.lineageId);
        if (again !== undefined && again !== null) {
          const parsed = parseRow(again as DecisionRow);
          if (parsed !== undefined) return ok(parsed);
        }
        return err({ kind: "duplicate_decision", decisionId: input.decisionId });
      }
      return err({ kind: "database_error", detail });
    }

    const item = getByDecisionId(input.decisionId);
    if (item === undefined) return err({ kind: "database_error", detail: "insert missing row" });
    return ok(item);
  };

  const recordDecision = (
    input: RecordDecisionInput,
  ): Result<RecordDecisionOutcome, DecisionQueueError> => {
    const item = getByDecisionId(input.decisionId);
    if (item === undefined) return err({ kind: "not_found", decisionId: input.decisionId });
    if (item.decidedAt !== undefined) {
      return err({ kind: "already_decided", decisionId: input.decisionId });
    }

    const next = applyHumanDecision(input.currentState, input.decision);
    if (!next.ok) return err(next.error);

    try {
      db.prepare(
        "UPDATE decision_items SET decided_at = ?, decision = ? WHERE decision_id = ?",
      ).run(input.decidedAt, input.decision, input.decisionId);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const updated = getByDecisionId(input.decisionId);
    if (updated === undefined) return err({ kind: "database_error", detail: "update missing row" });
    return ok({ item: updated, nextState: next.value });
  };

  const pendingCount = (): Result<number, DecisionQueueError> => {
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM decision_items WHERE decided_at IS NULL")
        .get(undefined) as { count?: unknown };
      return ok(typeof row.count === "number" ? row.count : 0);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const listPending = (): Result<readonly DecisionItem[], DecisionQueueError> => {
    try {
      const rows = db
        .prepare("SELECT * FROM decision_items WHERE decided_at IS NULL ORDER BY enqueued_at ASC")
        .all(undefined);
      const items: DecisionItem[] = [];
      for (const row of rows) {
        const parsed = parseRow(row as DecisionRow);
        if (parsed !== undefined) items.push(parsed);
      }
      return ok(items);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const getByLineageId = (
    lineageId: LineageId,
  ): Result<DecisionItem | undefined, DecisionQueueError> => {
    try {
      const row = db.prepare("SELECT * FROM decision_items WHERE lineage_id = ?").get(lineageId);
      if (row === undefined || row === null) return ok(undefined);
      const parsed = parseRow(row as DecisionRow);
      if (parsed === undefined) return err({ kind: "database_error", detail: "corrupt row" });
      return ok(parsed);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    dbPath,
    enqueue,
    recordDecision,
    pendingCount,
    listPending,
    getByLineageId,
    close: () => db.close(),
  };
};
