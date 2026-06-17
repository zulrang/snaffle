import type { GateCheckKind, GatePhase } from "../domain/gate";
import { GATE_CHECK_ORDER } from "../domain/gate";
import type { BatchId, GateRunId, LineageId } from "../domain/ids";
import { BatchId as parseBatchId, LineageId as parseLineageId } from "../domain/ids";
import { err, ok, parseTimestamp, type Result, type Timestamp } from "../domain/shared";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

/**
 * Gate span store (D10, S4/W8). Persists PRE/POST gate invocations scoped to
 * lineage (and optional batch) for red attribution.
 */

export const SPAN_DB_DIR = ".orchestrator";
export const SPAN_DB_FILE = "gate-spans.sqlite";

export type GateSpanOutcome = "green" | "red" | "running";

export interface GateSpan {
  readonly spanId: string;
  readonly gateRunId: GateRunId;
  readonly lineageId: LineageId;
  readonly batchId?: BatchId;
  readonly phase: GatePhase;
  readonly stageKind?: GateCheckKind;
  readonly outcome: GateSpanOutcome;
  readonly startedAt: Timestamp;
  readonly endedAt?: Timestamp;
}

export type GateSpanError = { readonly kind: "database_error"; readonly detail: string };

export interface GateSpanStore {
  readonly dbPath: string;
  recordSpan(span: GateSpan): Result<GateSpan, GateSpanError>;
  listByGateRun(gateRunId: GateRunId): Result<readonly GateSpan[], GateSpanError>;
  listByLineage(lineageId: LineageId): Result<readonly GateSpan[], GateSpanError>;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gate_spans (
  span_id TEXT PRIMARY KEY,
  gate_run_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  batch_id TEXT,
  phase TEXT NOT NULL,
  stage_kind TEXT,
  outcome TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_span_gate_run ON gate_spans (gate_run_id);
CREATE INDEX IF NOT EXISTS idx_span_lineage ON gate_spans (lineage_id);
`;

interface SpanRow {
  readonly span_id: unknown;
  readonly gate_run_id: unknown;
  readonly lineage_id: unknown;
  readonly batch_id: unknown;
  readonly phase: unknown;
  readonly stage_kind: unknown;
  readonly outcome: unknown;
  readonly started_at: unknown;
  readonly ended_at: unknown;
}

const parseRow = (row: SpanRow): GateSpan | undefined => {
  if (
    typeof row.span_id !== "string" ||
    typeof row.gate_run_id !== "string" ||
    typeof row.lineage_id !== "string" ||
    typeof row.phase !== "string" ||
    typeof row.outcome !== "string" ||
    typeof row.started_at !== "number"
  ) {
    return undefined;
  }
  if (row.phase !== "pre" && row.phase !== "post") return undefined;
  if (row.outcome !== "green" && row.outcome !== "red" && row.outcome !== "running") {
    return undefined;
  }
  const lineageId = parseLineageId(row.lineage_id);
  const startedAt = parseTimestamp(row.started_at);
  if (!lineageId.ok || !startedAt.ok) return undefined;

  let batchId: BatchId | undefined;
  if (typeof row.batch_id === "string" && row.batch_id.length > 0) {
    const parsed = parseBatchId(row.batch_id);
    if (!parsed.ok) return undefined;
    batchId = parsed.value;
  }

  let endedAt: Timestamp | undefined;
  if (typeof row.ended_at === "number") {
    const parsed = parseTimestamp(row.ended_at);
    if (!parsed.ok) return undefined;
    endedAt = parsed.value;
  }

  const stageKind =
    typeof row.stage_kind === "string" &&
    (GATE_CHECK_ORDER as readonly string[]).includes(row.stage_kind)
      ? (row.stage_kind as GateCheckKind)
      : undefined;

  return {
    spanId: row.span_id,
    gateRunId: row.gate_run_id as GateRunId,
    lineageId: lineageId.value,
    ...(batchId === undefined ? {} : { batchId }),
    phase: row.phase,
    ...(stageKind === undefined ? {} : { stageKind }),
    outcome: row.outcome,
    startedAt: startedAt.value,
    ...(endedAt === undefined ? {} : { endedAt }),
  };
};

export const openGateSpanStore = (dbPath: string): GateSpanStore => {
  const db: SqliteDatabase = openSqliteDatabase(dbPath);
  db.exec(SCHEMA);

  const recordSpan = (span: GateSpan): Result<GateSpan, GateSpanError> => {
    try {
      db.prepare(
        `INSERT INTO gate_spans (
          span_id, gate_run_id, lineage_id, batch_id, phase, stage_kind, outcome, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        span.spanId,
        span.gateRunId,
        span.lineageId,
        span.batchId ?? null,
        span.phase,
        span.stageKind ?? null,
        span.outcome,
        span.startedAt,
        span.endedAt ?? null,
      );
      return ok(span);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const listByGateRun = (gateRunId: GateRunId): Result<readonly GateSpan[], GateSpanError> => {
    try {
      const rows = db
        .prepare("SELECT * FROM gate_spans WHERE gate_run_id = ? ORDER BY started_at ASC")
        .all(gateRunId);
      const spans: GateSpan[] = [];
      for (const row of rows) {
        const parsed = parseRow(row as SpanRow);
        if (parsed !== undefined) spans.push(parsed);
      }
      return ok(spans);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const listByLineage = (lineageId: LineageId): Result<readonly GateSpan[], GateSpanError> => {
    try {
      const rows = db
        .prepare("SELECT * FROM gate_spans WHERE lineage_id = ? ORDER BY started_at ASC")
        .all(lineageId);
      const spans: GateSpan[] = [];
      for (const row of rows) {
        const parsed = parseRow(row as SpanRow);
        if (parsed !== undefined) spans.push(parsed);
      }
      return ok(spans);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return { dbPath, recordSpan, listByGateRun, listByLineage, close: () => db.close() };
};

/** Build paired PRE/POST spans for one gate run (S4 promotion helper). */
export const gateSpanPair = (input: {
  readonly gateRunId: GateRunId;
  readonly lineageId: LineageId;
  readonly batchId?: BatchId;
  readonly at: Timestamp;
  readonly postOutcome: GateSpanOutcome;
  readonly postStageKind?: GateCheckKind;
  readonly endedAt: Timestamp;
}): readonly GateSpan[] => {
  const base = {
    gateRunId: input.gateRunId,
    lineageId: input.lineageId,
    ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
  };
  return [
    {
      spanId: `${String(input.gateRunId)}-pre`,
      ...base,
      phase: "pre",
      outcome: "green",
      startedAt: input.at,
      endedAt: input.endedAt,
    },
    {
      spanId: `${String(input.gateRunId)}-post`,
      ...base,
      phase: "post",
      ...(input.postStageKind === undefined ? {} : { stageKind: input.postStageKind }),
      outcome: input.postOutcome,
      startedAt: input.at,
      endedAt: input.endedAt,
    },
  ];
};
