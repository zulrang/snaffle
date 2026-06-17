import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWriterLock,
  attachObserver,
  readWriterClaim,
  reclaimStaleLock,
} from "./ownership-lock";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W2 — single-writer ownership lock (D23)", () => {
  let workspaceRoot: string;

  afterEach(() => {
    if (workspaceRoot) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("second writer fails fast while the first orchestrator holds the lock", async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "orchestrator-w2-"));

    const first = must(await acquireWriterLock({ workspaceRoot, ownerId: "orchestrator-a" }));
    expect(first.ownerId).toBe("orchestrator-a");

    const second = await acquireWriterLock({ workspaceRoot, ownerId: "orchestrator-b" });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected fail-fast");
    expect(second.error.kind).toBe("workspace_already_owned");
    if (second.error.kind === "workspace_already_owned") {
      expect(second.error.ownerId).toBe("orchestrator-a");
      expect(second.error.pid).toBe(process.pid);
    }

    await first.release();

    const third = must(await acquireWriterLock({ workspaceRoot, ownerId: "orchestrator-c" }));
    expect(third.ownerId).toBe("orchestrator-c");
    await third.release();
  });

  test("read-only observer attaches without taking the lock", async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "orchestrator-w2-"));

    const writer = must(await acquireWriterLock({ workspaceRoot, ownerId: "writer-1" }));
    const observer = must(await attachObserver(workspaceRoot));

    expect(observer.writer?.ownerId).toBe("writer-1");
    expect(observer.writer?.alive).toBe(true);
    expect(observer.writer?.pid).toBe(process.pid);

    const claimAfterObserver = await readWriterClaim(workspaceRoot);
    expect(claimAfterObserver?.ownerId).toBe("writer-1");

    observer.detach();
    await writer.release();
  });

  test("releases on normal exit and reclaims after a simulated crash", async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "orchestrator-w2-"));
    const fixture = join(import.meta.dir, "fixtures/lock-crash-holder.ts");

    const child = Bun.spawn(["bun", fixture, workspaceRoot, "crash-child"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = child.stdout.getReader();
    const held = new TextDecoder().decode((await reader.read()).value);
    expect(held.trim()).toBe("held");

    const claimWhileAlive = await readWriterClaim(workspaceRoot);
    expect(claimWhileAlive?.alive).toBe(true);
    expect(claimWhileAlive?.ownerId).toBe("crash-child");

    process.kill(child.pid, "SIGKILL");
    await child.exited;

    expect(await reclaimStaleLock(workspaceRoot)).toBe(true);

    const claimAfterCrash = await readWriterClaim(workspaceRoot);
    expect(claimAfterCrash).toBeNull();

    const replacement = must(
      await acquireWriterLock({ workspaceRoot, ownerId: "orchestrator-after-crash" }),
    );
    expect(replacement.ownerId).toBe("orchestrator-after-crash");
    await replacement.release();
  });
});

describe("ownership lock — unit cases", () => {
  let workspaceRoot: string;

  afterEach(() => {
    if (workspaceRoot) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects an empty workspace path", async () => {
    const result = await acquireWriterLock({ workspaceRoot: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("invalid_workspace");
  });

  test("release removes the lock file so the workspace is unowned", async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "orchestrator-w2-"));

    const lock = must(await acquireWriterLock({ workspaceRoot, ownerId: "writer" }));
    expect((await readWriterClaim(workspaceRoot))?.alive).toBe(true);

    await lock.release();
    expect(await readWriterClaim(workspaceRoot)).toBeNull();
  });
});
