import { acquireWriterLock } from "../ownership-lock";

const workspaceRoot = process.argv[2];
const ownerId = process.argv[3];
if (!workspaceRoot || !ownerId) {
  console.error("usage: lock-concurrent-acquirer.ts <workspaceRoot> <ownerId>");
  process.exit(2);
}

const result = await acquireWriterLock({ workspaceRoot, ownerId });
if (result.ok) {
  console.log("held");
  await Bun.sleep(500);
  await result.value.release();
} else {
  console.log("fail");
}
