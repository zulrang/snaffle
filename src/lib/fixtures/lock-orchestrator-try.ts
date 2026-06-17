/**
 * Attempts to acquire the writer lock (second orchestrator). Fails fast or succeeds.
 *
 * Usage: bun lock-orchestrator-try.ts <workspaceRoot> <ownerId>
 */
import { acquireWriterLock } from "../ownership-lock";

const [workspaceRoot, ownerId] = process.argv.slice(2);
if (!workspaceRoot || !ownerId) {
  console.error("usage: lock-orchestrator-try.ts <workspaceRoot> <ownerId>");
  process.exit(2);
}

const t0 = performance.now();
const result = await acquireWriterLock({ workspaceRoot, ownerId });
const elapsedMs = performance.now() - t0;

if (result.ok) {
  console.log(
    JSON.stringify({
      event: "acquired",
      ownerId: result.value.ownerId,
      pid: result.value.record.pid,
      elapsedMs,
    }),
  );
  await result.value.release();
  process.exit(0);
}

console.log(JSON.stringify({ event: "rejected", error: result.error, elapsedMs }));
process.exit(0);
