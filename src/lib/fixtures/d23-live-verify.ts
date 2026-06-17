/**
 * Live D23 verification — run all lock scenarios against real subprocesses.
 *
 * Usage: bun d23-live-verify.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWriterLock, OWNERSHIP_LOCK_DIR, OWNERSHIP_LOCK_FILE } from "../ownership-lock";

const fixtureDir = import.meta.dir;
const hold = join(fixtureDir, "lock-orchestrator-hold.ts");
const tryAcquire = join(fixtureDir, "lock-orchestrator-try.ts");
const observe = join(fixtureDir, "lock-orchestrator-observe.ts");
const crashHolder = join(fixtureDir, "lock-crash-holder.ts");
const raceAcquirer = join(fixtureDir, "lock-concurrent-acquirer.ts");

const results: { name: string; pass: boolean; detail: string }[] = [];

const pass = (name: string, detail: string) => {
  results.push({ name, pass: true, detail });
  console.log(`PASS  ${name}: ${detail}`);
};

const fail = (name: string, detail: string) => {
  results.push({ name, pass: false, detail });
  console.error(`FAIL  ${name}: ${detail}`);
};

const readFirstLine = async (stdout: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stdout.getReader();
  const chunk = await reader.read();
  return new TextDecoder().decode(chunk.value).trim();
};

const readAll = async (proc: ReturnType<typeof Bun.spawn>): Promise<string> => {
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  await proc.exited;
  return text.trim();
};

const stdoutOf = (proc: ReturnType<typeof Bun.spawn>): ReadableStream<Uint8Array> =>
  proc.stdout as ReadableStream<Uint8Array>;

const workspace = mkdtempSync(join(tmpdir(), "d23-live-"));
const lockPath = join(workspace, OWNERSHIP_LOCK_DIR, OWNERSHIP_LOCK_FILE);

try {
  // 1) Second writer fails fast while first holds the lock
  {
    const holder = Bun.spawn(["bun", hold, workspace, "orchestrator-a", "15000"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const startedLine = await readFirstLine(stdoutOf(holder));
    const started = JSON.parse(startedLine) as { event: string; ownerId: string };
    if (started.event !== "started" || started.ownerId !== "orchestrator-a") {
      fail("fail-fast second writer", `holder did not start: ${startedLine}`);
    } else {
      const t0 = performance.now();
      const second = Bun.spawn(["bun", tryAcquire, workspace, "orchestrator-b"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const secondOut = await readAll(second);
      const elapsedMs = performance.now() - t0;
      const parsed = JSON.parse(secondOut) as {
        event: string;
        error?: { kind: string; ownerId?: string };
        elapsedMs?: number;
      };

      if (elapsedMs > 2000) {
        fail("fail-fast second writer", `second acquire took ${elapsedMs.toFixed(0)}ms (hung?)`);
      } else if (parsed.event !== "rejected" || parsed.error?.kind !== "workspace_already_owned") {
        fail("fail-fast second writer", `expected workspace_already_owned, got ${secondOut}`);
      } else if (parsed.error.ownerId !== "orchestrator-a") {
        fail("fail-fast second writer", `wrong owner in error: ${secondOut}`);
      } else {
        pass(
          "fail-fast second writer",
          `rejected in ${parsed.elapsedMs?.toFixed(1) ?? elapsedMs.toFixed(0)}ms with workspace_already_owned`,
        );
      }
    }
    holder.kill("SIGTERM");
    await holder.exited;
  }

  // 2) SIGKILL mid-run → fresh orchestrator reclaims stale lock (no deadlock)
  {
    const child = Bun.spawn(["bun", crashHolder, workspace, "crash-victim"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const held = await readFirstLine(stdoutOf(child));
    if (held !== "held") {
      fail("SIGKILL stale reclaim", `crash holder did not acquire: ${held}`);
    } else {
      process.kill(child.pid, "SIGKILL");
      await child.exited;

      const staleRaw = readFileSync(lockPath, "utf8");
      const t0 = performance.now();
      const reclaimed = await acquireWriterLock({
        workspaceRoot: workspace,
        ownerId: "after-crash",
      });
      const elapsedMs = performance.now() - t0;

      if (!reclaimed.ok) {
        fail(
          "SIGKILL stale reclaim",
          `fresh acquire failed after SIGKILL: ${JSON.stringify(reclaimed.error)}`,
        );
      } else if (elapsedMs > 2000) {
        fail("SIGKILL stale reclaim", `reclaim took ${elapsedMs.toFixed(0)}ms (deadlock?)`);
      } else if (reclaimed.value.ownerId !== "after-crash") {
        fail("SIGKILL stale reclaim", `wrong new owner: ${reclaimed.value.ownerId}`);
      } else {
        pass(
          "SIGKILL stale reclaim",
          `reclaimed in ${elapsedMs.toFixed(0)}ms (stale pid in ${staleRaw.slice(0, 80)}…)`,
        );
        await reclaimed.value.release();
      }
    }
  }

  // 3) Near-simultaneous race — exactly one wins, every iteration
  {
    const iterations = 25;
    let bad = 0;
    for (let i = 0; i < iterations; i += 1) {
      const a = Bun.spawn(["bun", raceAcquirer, workspace, `race-a-${i}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const b = Bun.spawn(["bun", raceAcquirer, workspace, `race-b-${i}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [outA, outB] = await Promise.all([readAll(a), readAll(b)]);
      const outcomes = [outA, outB].sort();
      if (outcomes.join(",") !== "fail,held") {
        bad += 1;
      }
    }
    if (bad > 0) {
      fail("concurrent race", `${bad}/${iterations} iterations did not produce exactly one holder`);
    } else {
      pass("concurrent race", `${iterations}/${iterations} iterations: exactly one held, one fail`);
    }
  }

  // 4) Read-only observer mid-run — no lock taken, no perturbation
  {
    const holder = Bun.spawn(["bun", hold, workspace, "writer-live", "12000"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const startedLine = await readFirstLine(stdoutOf(holder));
    const started = JSON.parse(startedLine) as { pid: number; startedAt: number };
    const lockBefore = readFileSync(lockPath, "utf8");

    const observerProc = Bun.spawn(["bun", observe, workspace], { stdout: "pipe", stderr: "pipe" });
    const observerOut = await readAll(observerProc);
    const lockAfter = readFileSync(lockPath, "utf8");

    const observed = JSON.parse(observerOut) as {
      event: string;
      observerWriter?: { ownerId: string; pid: number; alive: boolean };
      lockUnchanged: boolean;
    };

    // Holder should still be ticking
    await Bun.sleep(300);
    const stillRunning = !holder.killed && holder.exitCode === null;

    if (observed.event !== "observed") {
      fail("read-only observer", `observe failed: ${observerOut}`);
    } else if (
      !observed.observerWriter?.alive ||
      observed.observerWriter.ownerId !== "writer-live"
    ) {
      fail("read-only observer", `observer did not see live writer: ${observerOut}`);
    } else if (observed.observerWriter.pid !== started.pid) {
      fail(
        "read-only observer",
        `pid mismatch: observer ${observed.observerWriter.pid} vs holder ${started.pid}`,
      );
    } else if (lockBefore !== lockAfter) {
      fail("read-only observer", "lock file changed after observer attach/detach");
    } else if (!observed.lockUnchanged) {
      fail("read-only observer", "readWriterClaim changed across observer lifecycle");
    } else if (!stillRunning) {
      fail("read-only observer", "holder exited during observation");
    } else {
      pass(
        "read-only observer",
        `saw live writer-live pid=${started.pid}, lock file unchanged, holder still running`,
      );
    }

    holder.kill("SIGTERM");
    await holder.exited;
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n--- D23 live: ${results.length - failed.length}/${results.length} passed ---`);
if (failed.length > 0) {
  process.exit(1);
}
