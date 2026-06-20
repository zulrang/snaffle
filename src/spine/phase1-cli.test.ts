import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../cli.ts";
import { acquireWriterLock } from "../lib/ownership-lock";
import {
  openProvenanceStore,
  PROVENANCE_DB_DIR,
  PROVENANCE_DB_FILE,
} from "../lib/provenance-store";
import {
  buildDefaultPhase1Lineage,
  buildPhase1RunIds,
  readPhase1Status,
  runPhase1,
} from "./phase1-cli.ts";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");

describe("phase1 CLI — argv parsing", () => {
  test("parses run and status commands", () => {
    expect(parseCliArgs(["run"])).toEqual({
      command: "run",
      repoRoot: process.cwd(),
      variant: "merge_success",
      legacySkeleton: false,
      provenanceLimit: 10,
      noPush: false,
      publishPr: false,
      live: false,
    });
    expect(parseCliArgs(["status", "--repo", "/tmp/ws", "--limit", "5"])).toEqual({
      command: "status",
      repoRoot: "/tmp/ws",
      variant: "merge_success",
      legacySkeleton: false,
      provenanceLimit: 5,
      noPush: false,
      publishPr: false,
      live: false,
    });
    expect(parseCliArgs(["run", "--variant", "scope_blocked", "--owner", "cli-a"])).toEqual({
      command: "run",
      repoRoot: process.cwd(),
      variant: "scope_blocked",
      legacySkeleton: false,
      ownerId: "cli-a",
      provenanceLimit: 10,
      noPush: false,
      publishPr: false,
      live: false,
    });
    expect(
      parseCliArgs([
        "run",
        "--config-file",
        "docs/dogfood-gate.example.toml",
        "--task-file",
        "docs/task.json",
      ]),
    ).toEqual({
      command: "run",
      repoRoot: process.cwd(),
      variant: "merge_success",
      legacySkeleton: false,
      provenanceLimit: 10,
      noPush: false,
      publishPr: false,
      configFile: "docs/dogfood-gate.example.toml",
      taskFile: "docs/task.json",
      live: false,
    });
    expect(parseCliArgs(["decisions", "list", "--repo", "/tmp/ws"])).toEqual({
      command: "decisions",
      repoRoot: "/tmp/ws",
      variant: "merge_success",
      legacySkeleton: false,
      provenanceLimit: 10,
      noPush: false,
      publishPr: false,
      decisionsCommand: "list",
      live: false,
    });
    expect(
      parseCliArgs([
        "resume",
        "--lineage",
        "lineage-1",
        "--repo",
        "/tmp/ws",
        "--no-push",
        "--publish-pr",
      ]),
    ).toEqual({
      command: "resume",
      repoRoot: "/tmp/ws",
      variant: "merge_success",
      legacySkeleton: false,
      provenanceLimit: 10,
      noPush: true,
      publishPr: true,
      lineageId: "lineage-1",
      live: false,
    });
    expect(parseCliArgs(["nope"])).toBeUndefined();
  });
});

describe("phase1 CLI — defaults", () => {
  test("buildDefaultPhase1Lineage and run ids are well-formed", () => {
    expect(buildDefaultPhase1Lineage().ok).toBe(true);
    expect(buildPhase1RunIds("cli-test").ok).toBe(true);
  });
});

describe("phase1 CLI — status (read-only observer)", () => {
  let workspaceRoot: string;

  afterEach(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("reports no writer and no provenance on an empty workspace", async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "phase1-cli-status-"));
    const status = must(await readPhase1Status(workspaceRoot));

    expect(status.writer).toBeNull();
    expect(status.provenance.exists).toBe(false);
    expect(status.provenance.recentGenerations).toEqual([]);
  });

  test("does not take the writer lock while a holder is active", async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "phase1-cli-status-"));
    const lock = must(await acquireWriterLock({ workspaceRoot, ownerId: "holder" }));

    const status = must(await readPhase1Status(workspaceRoot));
    expect(status.writer?.ownerId).toBe("holder");
    expect(status.writer?.alive).toBe(true);

    await lock.release();
  });
});

describe("phase1 CLI — run (W8 loop)", () => {
  afterEach(async () => {
    const lockPath = join(repoRoot, ".snaffle", "ownership.lock.json");
    if (existsSync(lockPath)) {
      rmSync(lockPath, { force: true });
    }
    const provenancePath = join(repoRoot, ".snaffle", "provenance.sqlite");
    if (existsSync(provenancePath)) {
      rmSync(provenancePath, { force: true });
    }
  });

  test("run merge_success completes the walking skeleton", async () => {
    const suffix = `cli-${Date.now()}`;
    const outcome = must(
      await runPhase1({
        repoRoot,
        variant: "merge_success",
        ownerId: "orchestrator-cli",
        runSuffix: suffix,
      }),
    );

    expect(outcome.kind).toBe("merged");

    const store = openProvenanceStore(join(repoRoot, PROVENANCE_DB_DIR, PROVENANCE_DB_FILE));
    const ids = must(buildPhase1RunIds(suffix));
    expect(must(store.getByGenerationId(ids.generationId))).toBeDefined();
    store.close();

    const status = must(await readPhase1Status(repoRoot));
    expect(status.provenance.exists).toBe(true);
    expect(status.provenance.recentGenerations.length).toBeGreaterThan(0);
    expect(status.writer).toBeNull();
  }, 60_000);
});
