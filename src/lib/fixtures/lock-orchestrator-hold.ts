/**
 * Simulates a long-running orchestrator session holding the writer lock.
 *
 * Usage: bun lock-orchestrator-hold.ts <workspaceRoot> <ownerId> [holdMs]
 */
import { acquireWriterLock } from "../ownership-lock";

const [workspaceRoot, ownerId, holdMsRaw] = process.argv.slice(2);
if (!workspaceRoot || !ownerId) {
  console.error("usage: lock-orchestrator-hold.ts <workspaceRoot> <ownerId> [holdMs]");
  process.exit(2);
}

const holdMs = holdMsRaw === undefined ? 30_000 : Number(holdMsRaw);
if (!Number.isFinite(holdMs) || holdMs <= 0) {
  console.error("holdMs must be a positive number");
  process.exit(2);
}

const acquired = await acquireWriterLock({ workspaceRoot, ownerId });
if (!acquired.ok) {
  console.log(JSON.stringify({ event: "acquire_failed", error: acquired.error }));
  process.exit(1);
}

console.log(
  JSON.stringify({
    event: "started",
    ownerId: acquired.value.ownerId,
    pid: acquired.value.record.pid,
    startedAt: acquired.value.record.startedAt,
  }),
);

const started = Date.now();
while (Date.now() - started < holdMs) {
  await Bun.sleep(200);
  console.log(JSON.stringify({ event: "tick", elapsedMs: Date.now() - started }));
}

await acquired.value.release();
console.log(JSON.stringify({ event: "released" }));
