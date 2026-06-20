import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOneWay } from "../domain/door";
import { DecisionId, LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { DECISION_DB_DIR, DECISION_DB_FILE, openDecisionQueueStore } from "../lib/decision-queue";
import { defaultPhase1GateConfig } from "../lib/gate-config";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { writeParkedChangeArtifact } from "../lib/parked-change-store";
import { resumeApprovedLineage } from "./resume-cli";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const initGitWorkspace = (workspace: string): void => {
  const run = (args: readonly string[]) => {
    const result = spawnSync("git", [...args], { cwd: workspace, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
    }
  };
  run(["init"]);
  run([
    "-c",
    "user.name=Snaffle Test",
    "-c",
    "user.email=snaffle@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
};

describe("resume approved lineage", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("approval authorizes; resume reapplies parked artifact and derives merged", async () => {
    workspace = mkdtempSync(join(tmpdir(), "snaffle-resume-"));
    initGitWorkspace(workspace);
    const ts = must(parseTimestamp(1_700_000_000_000));
    const lineageId = must(LineageId("lineage-resume"));
    const decisionId = must(DecisionId("dec-resume"));
    const artifact = must(
      writeParkedChangeArtifact(workspace, {
        lineageId,
        plan: { regime: "minimal", phases: ["implement", "validate"], terminal: "auto_merge" },
        config: defaultOrchestratorConfig(),
        gateConfig: {
          ...defaultPhase1GateConfig(),
          stages: [
            {
              kind: "full_tests",
              command: ["sh", "-c", "test -f approved.txt"],
            },
          ],
        },
        scope: ["approved.txt"],
        writes: [{ path: "approved.txt", content: "approved\n" }],
        createdAt: ts,
      }),
    );

    const store = openDecisionQueueStore(join(workspace, DECISION_DB_DIR, DECISION_DB_FILE));
    must(
      store.enqueue({
        decisionId,
        lineageId,
        kind: "merge_hold",
        door: must(classifyOneWay(["public_contract"])),
        enqueuedAt: ts,
        parkedChangeHash: String(artifact.artifactHash),
      }),
    );
    must(
      store.recordDecision({
        decisionId,
        decision: "approve",
        currentState: { status: "awaiting_human" },
        decidedAt: ts,
      }),
    );
    store.close();

    const resumed = must(
      await resumeApprovedLineage(workspace, String(lineageId), {
        vcs: {
          commitAndPush: async () => ({ ok: true, value: { kind: "already_applied" } }),
        },
      }),
    );

    expect(resumed.kind).toBe("merged");
    if (resumed.kind !== "merged") throw new Error("expected merged");
    expect(resumed.transition.from).toEqual({ status: "approved_for_merge" });
    expect(resumed.transition.to).toEqual({ status: "merged" });
    expect(resumed.artifactHash).toBe(String(artifact.artifactHash));
    expect(existsSync(join(workspace, "approved.txt"))).toBe(true);
    expect(readFileSync(join(workspace, "approved.txt"), "utf8")).toBe("approved\n");
  });

  test("no-push resume validates without deriving merged", async () => {
    workspace = mkdtempSync(join(tmpdir(), "snaffle-resume-no-push-"));
    initGitWorkspace(workspace);
    const ts = must(parseTimestamp(1_700_000_000_000));
    const lineageId = must(LineageId("lineage-no-push"));
    const decisionId = must(DecisionId("dec-no-push"));
    const artifact = must(
      writeParkedChangeArtifact(workspace, {
        lineageId,
        plan: { regime: "minimal", phases: ["implement", "validate"], terminal: "auto_merge" },
        config: defaultOrchestratorConfig(),
        gateConfig: {
          ...defaultPhase1GateConfig(),
          stages: [
            {
              kind: "full_tests",
              command: ["sh", "-c", "test -f preview.txt"],
            },
          ],
        },
        scope: ["preview.txt"],
        writes: [{ path: "preview.txt", content: "preview\n" }],
        createdAt: ts,
      }),
    );

    const store = openDecisionQueueStore(join(workspace, DECISION_DB_DIR, DECISION_DB_FILE));
    must(
      store.enqueue({
        decisionId,
        lineageId,
        kind: "two_way_sample",
        door: { direction: "two_way" },
        enqueuedAt: ts,
        parkedChangeHash: String(artifact.artifactHash),
      }),
    );
    must(
      store.recordDecision({
        decisionId,
        decision: "approve",
        currentState: { status: "awaiting_human" },
        decidedAt: ts,
      }),
    );
    store.close();

    const resumed = must(
      await resumeApprovedLineage(workspace, String(lineageId), { noPush: true }),
    );
    expect(resumed.kind).toBe("validated_no_push");
    if (resumed.kind !== "validated_no_push") throw new Error("expected no-push preview");
    expect(resumed.artifactHash).toBe(String(artifact.artifactHash));
    expect(resumed.vcs).toEqual({
      kind: "would_commit_and_push",
      paths: ["preview.txt"],
    });
    expect(existsSync(join(workspace, "preview.txt"))).toBe(false);
  });

  test("missing artifact re-parks instead of honoring a stale approval", async () => {
    workspace = mkdtempSync(join(tmpdir(), "snaffle-resume-missing-"));
    initGitWorkspace(workspace);
    const ts = must(parseTimestamp(1_700_000_000_000));
    const lineageId = must(LineageId("lineage-stale"));
    const decisionId = must(DecisionId("dec-stale"));
    const store = openDecisionQueueStore(join(workspace, DECISION_DB_DIR, DECISION_DB_FILE));
    must(
      store.enqueue({
        decisionId,
        lineageId,
        kind: "merge_hold",
        door: must(classifyOneWay(["public_contract"])),
        enqueuedAt: ts,
        parkedChangeHash: "b".repeat(64),
      }),
    );
    must(
      store.recordDecision({
        decisionId,
        decision: "approve",
        currentState: { status: "awaiting_human" },
        decidedAt: ts,
      }),
    );
    store.close();

    const resumed = must(await resumeApprovedLineage(workspace, String(lineageId)));
    expect(resumed.kind).toBe("reparked");
    if (resumed.kind !== "reparked") throw new Error("expected reparked");
    expect(resumed.reason).toBe("missing_artifact");
    expect(resumed.item.decision).toBeUndefined();
    expect(resumed.item.approvedChangeHash).toBeUndefined();
  });
});
