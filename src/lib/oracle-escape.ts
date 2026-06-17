import type { LineageId } from "../domain/ids";
import { LineageId as parseLineageId } from "../domain/ids";
import { err, ok, parseTimestamp, type Result, type Timestamp } from "../domain/shared";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

/**
 * Oracle escape logger (D24, S3/W6). Records downstream catches of green-gate
 * misses; clusters by criterion to drive fixes at test-author, not patches.
 */

export const ESCAPE_DB_DIR = ".orchestrator";
export const ESCAPE_DB_FILE = "oracle-escapes.sqlite";

export type OracleEscapeSource = "hitl" | "sample" | "metric";

export interface OracleEscapeRecord {
  readonly lineageId: LineageId;
  readonly missedCriterion: string;
  readonly source: OracleEscapeSource;
  readonly recordedAt: Timestamp;
}

export type OracleEscapeError =
  | { readonly kind: "database_error"; readonly detail: string }
  | { readonly kind: "invalid_id"; readonly detail: string };

export interface OracleEscapeCluster {
  readonly missedCriterion: string;
  readonly count: number;
  readonly lineageIds: readonly LineageId[];
}

export interface OracleEscapeStore {
  readonly dbPath: string;
  recordEscape(input: OracleEscapeRecord): Result<OracleEscapeRecord, OracleEscapeError>;
  listByLineage(lineageId: LineageId): Result<readonly OracleEscapeRecord[], OracleEscapeError>;
  clusterByCriterion(): Result<readonly OracleEscapeCluster[], OracleEscapeError>;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oracle_escapes (
  lineage_id TEXT NOT NULL,
  missed_criterion TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (lineage_id, source)
);

CREATE INDEX IF NOT EXISTS idx_escape_criterion ON oracle_escapes (missed_criterion);
`;

interface EscapeRow {
  readonly lineage_id: unknown;
  readonly missed_criterion: unknown;
  readonly source: unknown;
  readonly recorded_at: unknown;
}

const parseRow = (row: EscapeRow): OracleEscapeRecord | undefined => {
  if (
    typeof row.lineage_id !== "string" ||
    typeof row.missed_criterion !== "string" ||
    typeof row.source !== "string" ||
    typeof row.recorded_at !== "number"
  ) {
    return undefined;
  }
  if (row.source !== "hitl" && row.source !== "sample" && row.source !== "metric") {
    return undefined;
  }
  const lineageId = parseLineageId(row.lineage_id);
  const recordedAt = parseTimestamp(row.recorded_at);
  if (!lineageId.ok || !recordedAt.ok) return undefined;
  return {
    lineageId: lineageId.value,
    missedCriterion: row.missed_criterion,
    source: row.source,
    recordedAt: recordedAt.value,
  };
};

export const openOracleEscapeStore = (dbPath: string): OracleEscapeStore => {
  const db: SqliteDatabase = openSqliteDatabase(dbPath);
  db.exec(SCHEMA);

  const recordEscape = (
    input: OracleEscapeRecord,
  ): Result<OracleEscapeRecord, OracleEscapeError> => {
    try {
      db.prepare(
        `INSERT INTO oracle_escapes (lineage_id, missed_criterion, source, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(lineage_id, source) DO UPDATE SET
           missed_criterion = excluded.missed_criterion,
           recorded_at = excluded.recorded_at`,
      ).run(input.lineageId, input.missedCriterion, input.source, input.recordedAt);
      return ok(input);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const listByLineage = (
    lineageId: LineageId,
  ): Result<readonly OracleEscapeRecord[], OracleEscapeError> => {
    try {
      const rows = db
        .prepare("SELECT * FROM oracle_escapes WHERE lineage_id = ? ORDER BY recorded_at ASC")
        .all(lineageId);
      const records: OracleEscapeRecord[] = [];
      for (const row of rows) {
        const parsed = parseRow(row as EscapeRow);
        if (parsed !== undefined) records.push(parsed);
      }
      return ok(records);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const clusterByCriterion = (): Result<readonly OracleEscapeCluster[], OracleEscapeError> => {
    try {
      const rows = db
        .prepare(
          `SELECT missed_criterion, lineage_id FROM oracle_escapes ORDER BY missed_criterion, lineage_id`,
        )
        .all(undefined) as EscapeRow[];
      const byCriterion = new Map<string, LineageId[]>();
      for (const row of rows) {
        if (typeof row.missed_criterion !== "string" || typeof row.lineage_id !== "string") {
          continue;
        }
        const id = parseLineageId(row.lineage_id);
        if (!id.ok) continue;
        const list = byCriterion.get(row.missed_criterion) ?? [];
        list.push(id.value);
        byCriterion.set(row.missed_criterion, list);
      }
      const clusters: OracleEscapeCluster[] = [...byCriterion.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([missedCriterion, lineageIds]) => ({
          missedCriterion,
          count: lineageIds.length,
          lineageIds,
        }));
      return ok(clusters);
    } catch (error) {
      return err({
        kind: "database_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return { dbPath, recordEscape, listByLineage, clusterByCriterion, close: () => db.close() };
};
