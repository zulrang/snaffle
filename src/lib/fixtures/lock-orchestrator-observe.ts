/**
 * Attaches a read-only observer and reports the current writer claim.
 *
 * Usage: bun lock-orchestrator-observe.ts <workspaceRoot>
 */
import { attachObserver, readWriterClaim } from "../ownership-lock";

const workspaceRoot = process.argv[2];
if (!workspaceRoot) {
  console.error("usage: lock-orchestrator-observe.ts <workspaceRoot>");
  process.exit(2);
}

const before = await readWriterClaim(workspaceRoot);
const attached = await attachObserver(workspaceRoot);
if (!attached.ok) {
  console.log(JSON.stringify({ event: "attach_failed", error: attached.error }));
  process.exit(1);
}

const afterAttach = await readWriterClaim(workspaceRoot);
attached.value.detach();
const afterDetach = await readWriterClaim(workspaceRoot);

console.log(
  JSON.stringify({
    event: "observed",
    before,
    observerWriter: attached.value.writer,
    afterAttach,
    afterDetach,
    lockUnchanged:
      JSON.stringify(before) === JSON.stringify(afterAttach) &&
      JSON.stringify(afterAttach) === JSON.stringify(afterDetach),
  }),
);
