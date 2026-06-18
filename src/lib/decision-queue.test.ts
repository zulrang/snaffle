import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOneWay } from "../domain/door";
import { DecisionId, LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import type { LineageState } from "../domain/transition";
import { DECISION_DB_FILE, enqueueAwaitingHuman, openDecisionQueueStore } from "./decision-queue";
import { closureRequiresDecision } from "./human-decision";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const ts = must(parseTimestamp(1_700_000_000_000));
const parked: LineageState = { status: "awaiting_human" };
const oneWay = must(classifyOneWay(["money"]));

describe("W5 — batched HITL decision queue (D11)", () => {
  let workspace: string;
  let store: ReturnType<typeof openDecisionQueueStore>;

  afterEach(() => {
    store?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const openStore = () => {
    workspace = mkdtempSync(join(tmpdir(), "w5-decisions-"));
    store = openDecisionQueueStore(join(workspace, DECISION_DB_FILE));
  };

  test("awaiting_human enqueues exactly one decision item (idempotent per lineage)", () => {
    openStore();
    const lineageId = must(LineageId("L1"));
    const decisionId = must(DecisionId("dec-L1"));

    must(
      enqueueAwaitingHuman(store, {
        decisionId,
        lineageId,
        door: oneWay,
        enqueuedAt: ts,
      }),
    );
    must(
      enqueueAwaitingHuman(store, {
        decisionId: must(DecisionId("dec-L1-dup")),
        lineageId,
        door: oneWay,
        enqueuedAt: ts,
      }),
    );

    expect(must(store.pendingCount())).toBe(1);
    expect(must(store.listPending())).toHaveLength(1);
  });

  test("pending decisions include durable review context", () => {
    openStore();
    const review = {
      summary: "Review a sampled dogfood docs write.",
      scope: ["docs"],
      acceptanceCriteria: ["bun run check remains green"],
      changedPaths: ["docs/dogfood-warmup.md"],
      writePreviews: [
        {
          path: "docs/dogfood-warmup.md",
          content: "# Dogfood Warmup\n",
        },
      ],
    };

    must(
      store.enqueue({
        decisionId: must(DecisionId("dec-review")),
        lineageId: must(LineageId("L-review")),
        kind: "two_way_sample",
        door: { direction: "two_way" },
        enqueuedAt: ts,
        review,
      }),
    );

    const pending = must(store.listPending());
    expect(pending[0]?.review).toEqual(review);
    store.close();

    store = openDecisionQueueStore(join(workspace, DECISION_DB_FILE));
    expect(must(store.listPending())[0]?.review).toEqual(review);
  });

  test("a recorded approval authorizes continuation without computing merged", () => {
    openStore();
    const lineageId = must(LineageId("L-approve"));
    const decisionId = must(DecisionId("dec-approve"));
    must(
      enqueueAwaitingHuman(store, {
        decisionId,
        lineageId,
        door: oneWay,
        enqueuedAt: ts,
        parkedChangeHash: "a".repeat(64),
      }),
    );

    const outcome = must(
      store.recordDecision({
        decisionId,
        decision: "approve",
        currentState: parked,
        decidedAt: ts,
      }),
    );

    expect(outcome.nextState).toEqual({ status: "approved_for_merge" });
    expect(outcome.item.decision).toBe("approve");
    expect(outcome.item.approvedChangeHash).toBe("a".repeat(64));
    expect(must(store.pendingCount())).toBe(0);
  });

  test("a recorded rejection closes the lineage as human_rejected", () => {
    openStore();
    const decisionId = must(DecisionId("dec-reject"));
    must(
      enqueueAwaitingHuman(store, {
        decisionId,
        lineageId: must(LineageId("L-reject")),
        door: oneWay,
        enqueuedAt: ts,
      }),
    );

    const outcome = must(
      store.recordDecision({
        decisionId,
        decision: "reject",
        currentState: parked,
        decidedAt: ts,
      }),
    );

    expect(outcome.nextState).toEqual({ status: "rejected", reason: "human_rejected" });
  });

  test("pending count is independent of any single lineage's closure", () => {
    openStore();
    must(
      enqueueAwaitingHuman(store, {
        decisionId: must(DecisionId("dec-a")),
        lineageId: must(LineageId("L-a")),
        door: oneWay,
        enqueuedAt: ts,
      }),
    );
    must(
      enqueueAwaitingHuman(store, {
        decisionId: must(DecisionId("dec-b")),
        lineageId: must(LineageId("L-b")),
        door: oneWay,
        enqueuedAt: ts,
      }),
    );

    expect(must(store.pendingCount())).toBe(2);
    must(
      store.recordDecision({
        decisionId: must(DecisionId("dec-a")),
        decision: "approve",
        currentState: parked,
        decidedAt: ts,
      }),
    );
    expect(must(store.pendingCount())).toBe(1);
  });

  test("queue empty is not goal met — closure requires a positive decision", () => {
    openStore();
    expect(must(store.pendingCount())).toBe(0);
    expect(closureRequiresDecision(0, parked)).toBe(true);
    expect(closureRequiresDecision(0, { status: "running", phase: "implement" })).toBe(false);
  });

  test("the queue survives reopen (durability)", () => {
    workspace = mkdtempSync(join(tmpdir(), "w5-durable-"));
    const dbPath = join(workspace, DECISION_DB_FILE);
    const first = openDecisionQueueStore(dbPath);
    must(
      enqueueAwaitingHuman(first, {
        decisionId: must(DecisionId("dec-durable")),
        lineageId: must(LineageId("L-durable")),
        door: oneWay,
        enqueuedAt: ts,
      }),
    );
    first.close();

    store = openDecisionQueueStore(dbPath);
    expect(must(store.pendingCount())).toBe(1);
  });
});
