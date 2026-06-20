import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
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

export const OWNERSHIP_LOCK_DIR = ".snaffle";
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
  /** True when the lock file exists but is not a valid LockRecord (blocks acquisition). */
  readonly corrupt?: boolean;
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

export const recordsMatch = (a: LockRecord, b: LockRecord): boolean =>
  a.ownerId === b.ownerId && a.pid === b.pid && a.startedAt === b.startedAt;

/** Non-destructive lock read: never unlinks on parse failure (D23 TOCTOU fix). */
export const readLockFileState = async (
  workspaceRoot: string,
): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "claim"; readonly record: LockRecord }
> => {
  const lockPath = lockPathFor(workspaceRoot);
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return { kind: "missing" };
  }

  const record = parseLockRecord(raw);
  if (!record) return { kind: "corrupt" };
  return { kind: "claim", record };
};

export const readWriterClaim = async (workspaceRoot: string): Promise<ActiveWriterClaim | null> => {
  const state = await readLockFileState(workspaceRoot);
  if (state.kind === "missing") return null;
  if (state.kind === "corrupt") {
    return { ownerId: "", pid: -1, startedAt: 0, alive: true, corrupt: true };
  }
  return { ...state.record, alive: isProcessAlive(state.record.pid) };
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;

/** Atomic create+write in one synchronous stretch so the file is never empty on disk. */
const tryCreateLockFile = (lockPath: string, record: LockRecord): boolean => {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, "wx");
    writeFileSync(fd, JSON.stringify(record), "utf8");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
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
  }

  async release(): Promise<void> {
    this.releaseSync();
  }

  private releaseSync(): void {
    if (this.released) return;
    this.released = true;
    process.off("exit", this.releaseOnExit);
    try {
      const raw = readFileSync(this.lockPath, "utf8");
      const onDisk = parseLockRecord(raw);
      if (onDisk && recordsMatch(onDisk, this.record)) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // ignore missing or unreadable lock file
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

  const existing = await readLockFileState(workspaceRoot);
  if (existing.kind === "corrupt") {
    return err({ kind: "lock_contention", detail: "corrupt ownership lock file" });
  }
  if (existing.kind === "claim" && isProcessAlive(existing.record.pid)) {
    return err({
      kind: "workspace_already_owned",
      ownerId: existing.record.ownerId,
      pid: existing.record.pid,
    });
  }
  if (existing.kind === "claim" && !isProcessAlive(existing.record.pid)) {
    await unlink(lockPath).catch(() => undefined);
  }

  const record: LockRecord = {
    ownerId: options.ownerId ?? `spine-${process.pid}-${Date.now()}`,
    pid: process.pid,
    startedAt: Date.now(),
  };

  if (!tryCreateLockFile(lockPath, record)) {
    const contender = await readLockFileState(workspaceRoot);
    if (contender.kind === "corrupt") {
      return err({ kind: "lock_contention", detail: "corrupt ownership lock file" });
    }
    if (contender.kind === "claim" && isProcessAlive(contender.record.pid)) {
      return err({
        kind: "workspace_already_owned",
        ownerId: contender.record.ownerId,
        pid: contender.record.pid,
      });
    }
    if (contender.kind === "claim") {
      await unlink(lockPath).catch(() => undefined);
    }
    if (!tryCreateLockFile(lockPath, record)) {
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
  const state = await readLockFileState(workspaceRoot);
  if (state.kind !== "claim") return false;
  if (isProcessAlive(state.record.pid)) return false;
  await unlink(lockPath).catch(() => undefined);
  return true;
};
