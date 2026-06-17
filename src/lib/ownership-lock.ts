import { unlinkSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../domain/shared";

/**
 * Single-writer workspace ownership lock (D23).
 *
 * Exactly one orchestrator may hold writer authority over a workspace. A second
 * writer fails fast; read-only observers attach without taking the lock. The
 * lock is a runtime claim (pid + owner id), not durable orchestrator state —
 * a dead pid means the lock is stale and may be reclaimed.
 */

export const OWNERSHIP_LOCK_DIR = ".orchestrator";
export const OWNERSHIP_LOCK_FILE = "ownership.lock.json";

export interface LockRecord {
  readonly ownerId: string;
  readonly pid: number;
  readonly startedAt: number;
}

export interface WriterLock {
  readonly workspaceRoot: string;
  readonly ownerId: string;
  readonly record: LockRecord;
  release(): Promise<void>;
}

export interface ActiveWriterClaim extends LockRecord {
  readonly alive: boolean;
}

export interface ObserverAttachment {
  readonly workspaceRoot: string;
  /** Current writer claim, if any; `alive` reflects a live pid check. */
  readonly writer: ActiveWriterClaim | null;
  detach(): void;
}

export type OwnershipLockError =
  | { readonly kind: "workspace_already_owned"; readonly ownerId: string; readonly pid: number }
  | { readonly kind: "lock_contention"; readonly detail: string }
  | { readonly kind: "invalid_workspace"; readonly detail: string };

export interface AcquireWriterOptions {
  readonly workspaceRoot: string;
  readonly ownerId?: string;
}

const lockPathFor = (workspaceRoot: string): string =>
  join(workspaceRoot, OWNERSHIP_LOCK_DIR, OWNERSHIP_LOCK_FILE);

export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const parseLockRecord = (raw: string): LockRecord | undefined => {
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (
      typeof parsed.ownerId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "number"
    ) {
      return undefined;
    }
    return {
      ownerId: parsed.ownerId,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
    };
  } catch {
    return undefined;
  }
};

export const readWriterClaim = async (workspaceRoot: string): Promise<ActiveWriterClaim | null> => {
  const lockPath = lockPathFor(workspaceRoot);
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return null;
  }

  const record = parseLockRecord(raw);
  if (!record) {
    await unlink(lockPath).catch(() => undefined);
    return null;
  }

  return { ...record, alive: isProcessAlive(record.pid) };
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;

const tryCreateLockFile = async (lockPath: string, record: LockRecord): Promise<boolean> => {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(record));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return false;
    throw error;
  }
};

class WriterLockHandle implements WriterLock {
  readonly workspaceRoot: string;
  readonly ownerId: string;
  readonly record: LockRecord;
  private readonly lockPath: string;
  private released = false;
  private readonly releaseOnExit: () => void;

  constructor(workspaceRoot: string, record: LockRecord, lockPath: string) {
    this.workspaceRoot = workspaceRoot;
    this.ownerId = record.ownerId;
    this.record = record;
    this.lockPath = lockPath;
    this.releaseOnExit = () => {
      this.releaseSync();
    };
    process.on("exit", this.releaseOnExit);
    process.on("SIGINT", this.releaseOnExit);
    process.on("SIGTERM", this.releaseOnExit);
  }

  async release(): Promise<void> {
    this.releaseSync();
  }

  private releaseSync(): void {
    if (this.released) return;
    this.released = true;
    process.off("exit", this.releaseOnExit);
    process.off("SIGINT", this.releaseOnExit);
    process.off("SIGTERM", this.releaseOnExit);
    try {
      unlinkSync(this.lockPath);
    } catch {
      // ignore missing file
    }
  }
}

/** Acquire exclusive writer ownership; fail fast if a live writer already holds the lock. */
export const acquireWriterLock = async (
  options: AcquireWriterOptions,
): Promise<Result<WriterLock, OwnershipLockError>> => {
  const workspaceRoot = options.workspaceRoot.trim();
  if (workspaceRoot.length === 0) {
    return err({ kind: "invalid_workspace", detail: "workspaceRoot must be non-empty" });
  }

  const lockDir = join(workspaceRoot, OWNERSHIP_LOCK_DIR);
  const lockPath = lockPathFor(workspaceRoot);
  await mkdir(lockDir, { recursive: true });

  const existing = await readWriterClaim(workspaceRoot);
  if (existing?.alive) {
    return err({
      kind: "workspace_already_owned",
      ownerId: existing.ownerId,
      pid: existing.pid,
    });
  }

  if (existing && !existing.alive) {
    await unlink(lockPath).catch(() => undefined);
  }

  const record: LockRecord = {
    ownerId: options.ownerId ?? `spine-${process.pid}-${Date.now()}`,
    pid: process.pid,
    startedAt: Date.now(),
  };

  if (!(await tryCreateLockFile(lockPath, record))) {
    const contender = await readWriterClaim(workspaceRoot);
    if (contender?.alive) {
      return err({
        kind: "workspace_already_owned",
        ownerId: contender.ownerId,
        pid: contender.pid,
      });
    }
    await unlink(lockPath).catch(() => undefined);
    if (!(await tryCreateLockFile(lockPath, record))) {
      return err({ kind: "lock_contention", detail: "Failed to acquire ownership lock" });
    }
  }

  return ok(new WriterLockHandle(workspaceRoot, record, lockPath));
};

/** Attach a read-only observer without taking the writer lock. */
export const attachObserver = async (
  workspaceRoot: string,
): Promise<Result<ObserverAttachment, OwnershipLockError>> => {
  const trimmed = workspaceRoot.trim();
  if (trimmed.length === 0) {
    return err({ kind: "invalid_workspace", detail: "workspaceRoot must be non-empty" });
  }

  const writer = await readWriterClaim(trimmed);
  return ok({
    workspaceRoot: trimmed,
    writer,
    detach: () => undefined,
  });
};

/** Remove a stale lock file when the recorded pid is no longer alive. */
export const reclaimStaleLock = async (workspaceRoot: string): Promise<boolean> => {
  const lockPath = lockPathFor(workspaceRoot);
  const claim = await readWriterClaim(workspaceRoot);
  if (!claim) return false;
  if (claim.alive) return false;
  await unlink(lockPath).catch(() => undefined);
  return true;
};
