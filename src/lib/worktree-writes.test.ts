import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWritesToWorktree } from "./worktree-writes";

describe("worktree writes — path confinement", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("applies a normal in-tree write", () => {
    root = mkdtempSync(join(tmpdir(), "orchestrator-wt-write-"));
    const result = applyWritesToWorktree(root, [{ path: "src/lib/marker.ts", content: "// ok\n" }]);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "src/lib/marker.ts"), "utf8")).toBe("// ok\n");
  });

  test("rejects writes through symlinks", () => {
    root = mkdtempSync(join(tmpdir(), "orchestrator-wt-write-"));
    const outside = mkdtempSync(join(tmpdir(), "orchestrator-wt-out-"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));

    const result = applyWritesToWorktree(root, [{ path: "link.txt", content: "pwned" }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected symlink rejection");
    expect(result.error.kind).toBe("symlink_target");

    rmSync(outside, { recursive: true, force: true });
  });

  test("rejects invalid repo paths", () => {
    root = mkdtempSync(join(tmpdir(), "orchestrator-wt-write-"));
    const result = applyWritesToWorktree(root, [{ path: "../escape.ts", content: "x" }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid path");
    expect(result.error.kind).toBe("invalid_path");
  });
});
