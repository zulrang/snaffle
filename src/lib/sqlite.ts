import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import BetterSqlite from "better-sqlite3";

/**
 * Cross-runtime SQLite adapter (D17/D18).
 *
 * Shipped path uses better-sqlite3 (Node). Bun dev falls back to bun:sqlite when
 * the native module is unavailable — ponytail: dual backend until Bun supports
 * better-sqlite3 (https://github.com/oven-sh/bun/issues/4290).
 */

export interface SqliteStatement {
  run(...params: unknown[]): void;
  get(param: unknown): unknown;
  all(param: unknown): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type BunSqliteDatabase = {
  exec(sql: string): void;
  query(sql: string): {
    run(...params: unknown[]): void;
    get(param: unknown): unknown;
    all(param: unknown): unknown[];
  };
  close(): void;
};

const wrapBunDatabase = (db: BunSqliteDatabase): SqliteDatabase => ({
  exec: (sql) => db.exec(sql),
  prepare: (sql) => {
    const stmt = db.query(sql);
    return {
      run: (...params) => stmt.run(...params),
      get: (param) => stmt.get(param),
      all: (param) => stmt.all(param),
    };
  },
  close: () => db.close(),
});

const wrapBetterDatabase = (db: BetterSqlite.Database): SqliteDatabase => ({
  exec: (sql) => db.exec(sql),
  prepare: (sql) => db.prepare(sql),
  close: () => db.close(),
});

const require = createRequire(import.meta.url);

const openBunDatabase = (dbPath: string): SqliteDatabase => {
  const bunModule = require("bun:sqlite") as { Database: new (path: string) => BunSqliteDatabase };
  return wrapBunDatabase(new bunModule.Database(dbPath));
};

export const openSqliteDatabase = (dbPath: string): SqliteDatabase => {
  mkdirSync(dirname(dbPath), { recursive: true });
  try {
    return wrapBetterDatabase(new BetterSqlite(dbPath));
  } catch (error) {
    if (process.versions.bun === undefined) throw error;
    return openBunDatabase(dbPath);
  }
};
