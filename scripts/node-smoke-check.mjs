import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import Database from "better-sqlite3";

test("node:child_process spawn works", async () => {
  const result = await new Promise((resolve, reject) => {
    const proc = spawn("node", ["-e", "process.stdout.write('ok')"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
});

test("better-sqlite3 opens under node", () => {
  const db = new Database(":memory:");
  const row = db.prepare("SELECT 1 AS n").get();
  assert.deepEqual(row, { n: 1 });
  db.close();
});
