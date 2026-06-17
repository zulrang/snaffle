/**
 * Test fixture: acquire a writer lock and hold until SIGKILL (simulated crash).
 *
 * Usage: bun lock-crash-holder.ts <workspaceRoot> <ownerId>
 */
import { acquireWriterLock } from "../ownership-lock.ts";

const [workspaceRoot, ownerId] = process.argv.slice(2);
if (!workspaceRoot || !ownerId) {
  console.error("usage: lock-crash-holder.ts <workspaceRoot> <ownerId>");
  process.exit(2);
}

const acquired = await acquireWriterLock({ workspaceRoot, ownerId });
if (!acquired.ok) {
  console.error(JSON.stringify(acquired.error));
  process.exit(3);
}

process.stdout.write("held\n");
await new Promise(() => {
  // Hold until the test sends SIGKILL — exit handlers must not run.
});
