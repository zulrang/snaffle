import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parseRepoPath } from "../domain/scope";
import { err, ok, type Result } from "../domain/shared";

/**
 * Apply orchestrator-known write content into an isolated worktree (W8).
 *
 * Agent results carry paths only; the spine supplies content when applying.
 * Paths are parsed, confined to the worktree root, and rejected if symlinks.
 */

export interface WorktreeWrite {
  readonly path: string;
  readonly content: string;
}

export type WorktreeWriteError =
  | { readonly kind: "invalid_path"; readonly detail: string }
  | { readonly kind: "path_escapes_worktree"; readonly detail: string }
  | { readonly kind: "symlink_target"; readonly detail: string };

const isPathInsideRoot = (rootReal: string, candidateReal: string): boolean => {
  const rel = relative(rootReal, candidateReal);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
};

/** Apply spine-supplied writes with path confinement checks. */
export const applyWritesToWorktree = (
  worktreeRoot: string,
  writes: readonly WorktreeWrite[],
): Result<void, WorktreeWriteError> => {
  const rootReal = realpathSync(worktreeRoot);

  for (const write of writes) {
    const parsed = parseRepoPath(write.path);
    if (!parsed.ok) {
      return err({ kind: "invalid_path", detail: write.path });
    }

    const fullPath = resolve(worktreeRoot, parsed.value);
    mkdirSync(dirname(fullPath), { recursive: true });

    try {
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        return err({ kind: "symlink_target", detail: parsed.value });
      }
    } catch {
      // target does not exist yet
    }

    const parentReal = realpathSync(dirname(fullPath));
    if (!isPathInsideRoot(rootReal, parentReal)) {
      return err({ kind: "path_escapes_worktree", detail: parsed.value });
    }

    writeFileSync(fullPath, write.content, "utf8");

    const writtenReal = realpathSync(fullPath);
    if (!isPathInsideRoot(rootReal, writtenReal)) {
      return err({ kind: "path_escapes_worktree", detail: parsed.value });
    }
  }

  return ok(undefined);
};
