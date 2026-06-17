import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Apply orchestrator-known write content into an isolated worktree (W8).
 *
 * Agent results carry paths only; the spine supplies content when applying.
 */

export interface WorktreeWrite {
  readonly path: string;
  readonly content: string;
}

export const applyWritesToWorktree = (
  worktreeRoot: string,
  writes: readonly WorktreeWrite[],
): void => {
  for (const write of writes) {
    const fullPath = join(worktreeRoot, write.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, write.content, "utf8");
  }
};
