import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { classifyTwoWay } from "../domain/door";
import { gatePassed } from "../domain/gate";
import {
  GateRunId,
  GenerationId,
  GrantId,
  InvocationId,
  LineageId,
  RequirementId,
  TransitionId,
} from "../domain/ids";
import { freezeAcceptanceTarget, makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseContentHash, parseTimestamp } from "../domain/shared";
import { OWNERSHIP_LOCK_DIR, OWNERSHIP_LOCK_FILE, readWriterClaim } from "../lib/ownership-lock";
import {
  openProvenanceStore,
  PROVENANCE_DB_DIR,
  PROVENANCE_DB_FILE,
} from "../lib/provenance-store";
import { runSkeletonLineage, type SkeletonRunIds } from "./skeleton-run";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");
const ts = must(parseTimestamp(1_700_000_000_000));
const scope = must(
  makeWriteScope([must(parseRepoPath("src/domain")), must(parseRepoPath("src/lib"))]),
);

const lineage = makeLineage({
  lineageId: must(LineageId("lineage-w8")),
  requirementId: must(RequirementId("req-w8")),
  door: classifyTwoWay(),
  acceptanceTarget: must(
    freezeAcceptanceTarget({
      targetHash: must(parseContentHash("b".repeat(64))),
      criteria: [{ id: "c1", statement: "skeleton merges on green POST-gate" }],
      frozenAt: ts,
    }),
  ),
  declaredScope: scope,
  createdAt: ts,
});

const idsFor = (suffix: string): SkeletonRunIds => ({
  grantId: must(GrantId(`grant-w8-${suffix}`)),
  invocationId: must(InvocationId(`inv-w8-${suffix}`)),
  generationId: must(GenerationId(`gen-w8-${suffix}`)),
  preGateRunId: must(GateRunId(`gate-w8-${suffix}-pre`)),
  postGateRunId: must(GateRunId(`gate-w8-${suffix}-post`)),
  transitionId: must(TransitionId(`tr-w8-${suffix}`)),
});

describe("W8 — end-to-end skeleton wiring", () => {
  afterEach(async () => {
    const orchestratorDir = join(repoRoot, OWNERSHIP_LOCK_DIR);
    const lockPath = join(orchestratorDir, OWNERSHIP_LOCK_FILE);
    if (existsSync(lockPath)) {
      const claim = await readWriterClaim(repoRoot);
      if (claim?.pid === process.pid) {
        rmSync(lockPath, { force: true });
      }
    }
    const provenancePath = join(orchestratorDir, PROVENANCE_DB_FILE);
    if (existsSync(provenancePath)) {
      rmSync(provenancePath, { force: true });
    }
  });

  test("drives a trivial change all the way to merge", async () => {
    const ids = idsFor("merge");
    const outcome = must(
      await runSkeletonLineage({
        repoRoot,
        lineage,
        variant: "merge_success",
        ids,
        ownerId: "orchestrator-w8-merge",
        at: ts,
      }),
    );

    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("expected merged");
    expect(outcome.finalState.status).toBe("merged");
    expect(outcome.transition.to.status).toBe("merged");
    expect(gatePassed(outcome.postGate)).toBe(true);

    const store = openProvenanceStore(join(repoRoot, PROVENANCE_DB_DIR, PROVENANCE_DB_FILE));
    const stored = must(store.getByGenerationId(ids.generationId));
    expect(stored?.record.invocationId).toBe(ids.invocationId);
    expect(must(store.verifyContextHash(ids.generationId))).toBe(true);
    store.close();

    expect(await readWriterClaim(repoRoot)).toBeNull();
  }, 60_000);

  test("blocks an out-of-scope write attempt (W3)", async () => {
    const ids = idsFor("scope");
    const outcome = must(
      await runSkeletonLineage({
        repoRoot,
        lineage,
        variant: "scope_blocked",
        ids,
        ownerId: "orchestrator-w8-scope",
        at: ts,
      }),
    );

    expect(outcome.kind).toBe("scope_blocked");
    if (outcome.kind !== "scope_blocked") throw new Error("expected scope_blocked");
    expect(outcome.scopeEvents.some((event) => event.kind === "write_denied")).toBe(true);
    expect(outcome.finalState).toEqual({ status: "running", phase: "implement" });
    expect(await readWriterClaim(repoRoot)).toBeNull();
  }, 60_000);

  test("rejects a variant whose POST-gate fails (W5/W6)", async () => {
    const ids = idsFor("post");
    const outcome = must(
      await runSkeletonLineage({
        repoRoot,
        lineage,
        variant: "post_gate_rejected",
        ids,
        ownerId: "orchestrator-w8-post",
        at: ts,
      }),
    );

    expect(outcome.kind).toBe("post_gate_rejected");
    if (outcome.kind !== "post_gate_rejected") throw new Error("expected post_gate_rejected");
    expect(gatePassed(outcome.postGate)).toBe(false);
    expect(outcome.finalState).toEqual({ status: "running", phase: "implement" });
    expect(await readWriterClaim(repoRoot)).toBeNull();
  }, 60_000);
});
