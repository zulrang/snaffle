import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../domain/shared";
import { spawnCommand } from "./spawn";

/**
 * Isolated git worktrees for gate execution (D20, W5).
 */

export interface WorktreeHandle {
  readonly root: string;
  readonly repoRoot: string;
  remove(): Promise<void>;
}

export type WorktreeError =
  | { readonly kind: "worktree_add_failed"; readonly detail: string }
  | { readonly kind: "worktree_remove_failed"; readonly detail: string }
  | { readonly kind: "node_modules_link_failed"; readonly detail: string };

const runGit = async (repoRoot: string, args: readonly string[]): Promise<Result<void, string>> => {
  const result = await spawnCommand(["git", ...args], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    return err(result.stderr.trim() || `git ${args.join(" ")} failed with ${result.exitCode}`);
  }
  return ok(undefined);
};

/** Create a detached worktree for isolated PRE/POST gate runs. */
export const createDetachedWorktree = async (
  repoRoot: string,
): Promise<Result<WorktreeHandle, WorktreeError>> => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-wt-"));

  const added = await runGit(repoRoot, ["worktree", "add", "--detach", root, "HEAD"]);
  if (!added.ok) {
    rmSync(root, { recursive: true, force: true });
    return err({ kind: "worktree_add_failed", detail: added.error });
  }

  try {
    symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  } catch (error) {
    await runGit(repoRoot, ["worktree", "remove", root, "--force"]);
    rmSync(root, { recursive: true, force: true });
    return err({
      kind: "node_modules_link_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return ok({
    root,
    repoRoot,
    remove: async () => {
      const removed = await runGit(repoRoot, ["worktree", "remove", root, "--force"]);
      rmSync(root, { recursive: true, force: true });
      if (!removed.ok) {
        throw new Error(removed.error);
      }
    },
  });
};
