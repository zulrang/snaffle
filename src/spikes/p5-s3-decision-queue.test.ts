import { describe, expect, test } from "bun:test";
import { classifyOneWay, type DoorClassification, requiresHumanSignOff } from "../domain/door";
import type { LineageState } from "../domain/transition";

/**
 * P5/S3 — batched decision queue + resume contract.
 *
 * Retires the HITL risk: an `awaiting_human` lineage enqueues exactly one
 * decision; a recorded approval resumes to a control-plane merge and a rejection
 * closes the lineage; "queue empty" is not "goal met" (closure is a positive
 * decision). Durability is delegated to the existing SQLite store pattern
 * (provenance-store) in W5 — this prototype proves the resume contract in-memory.
 */

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

type Decision = "approve" | "reject";

interface DecisionItem {
  readonly lineageId: string;
  readonly door: DoorClassification;
  decided: boolean;
}

// W5 uses domain `human_rejected` (added in W2).
type ResumeOutcome =
  | { readonly status: "merged" }
  | { readonly status: "rejected"; readonly reason: "human_rejected" }
  | { readonly status: "unchanged"; readonly state: LineageState };

const resolveHumanDecision = (state: LineageState, decision: Decision): ResumeOutcome => {
  if (state.status !== "awaiting_human") return { status: "unchanged", state };
  return decision === "approve"
    ? { status: "merged" }
    : { status: "rejected", reason: "human_rejected" };
};

class DecisionQueue {
  private readonly items = new Map<string, DecisionItem>();

  enqueue(lineageId: string, door: DoorClassification): void {
    // One-way doors must park (D5/D11); the queue holds exactly one item per lineage.
    if (!requiresHumanSignOff(door)) return;
    this.items.set(lineageId, { lineageId, door, decided: false });
  }

  pending(): number {
    return [...this.items.values()].filter((i) => !i.decided).length;
  }

  record(lineageId: string, state: LineageState, decision: Decision): ResumeOutcome {
    const item = this.items.get(lineageId);
    if (item === undefined) return { status: "unchanged", state };
    item.decided = true;
    return resolveHumanDecision(state, decision);
  }
}

const oneWay = must(classifyOneWay(["money"]));
const parked: LineageState = { status: "awaiting_human" };

describe("P5/S3 — decision queue + resume", () => {
  test("an awaiting_human (one-way) lineage enqueues exactly one decision item", () => {
    const q = new DecisionQueue();
    q.enqueue("L1", oneWay);
    q.enqueue("L1", oneWay); // idempotent — still one item
    expect(q.pending()).toBe(1);
  });

  test("a recorded approval resumes to a control-plane merge", () => {
    const q = new DecisionQueue();
    q.enqueue("L1", oneWay);
    const next = q.record("L1", parked, "approve");
    expect(next.status).toBe("merged");
    expect(q.pending()).toBe(0);
  });

  test("a recorded rejection closes the lineage as rejected", () => {
    const q = new DecisionQueue();
    q.enqueue("L1", oneWay);
    const next = q.record("L1", parked, "reject");
    expect(next.status).toBe("rejected");
    if (next.status === "rejected") expect(next.reason).toBe("human_rejected");
  });

  test("pending count is independent of any single lineage's closure", () => {
    const q = new DecisionQueue();
    q.enqueue("L1", oneWay);
    q.enqueue("L2", oneWay);
    expect(q.pending()).toBe(2);
    q.record("L1", parked, "approve");
    expect(q.pending()).toBe(1); // L2 still awaits, unaffected by L1 closing
  });

  test("queue empty is not goal met — closure requires a positive decision", () => {
    const q = new DecisionQueue();
    expect(q.pending()).toBe(0); // empty queue
    // A still-running lineage that was never enqueued is not merged by emptiness.
    const running: LineageState = { status: "running", phase: "implement" };
    expect(resolveHumanDecision(running, "approve").status).toBe("unchanged");
  });
});
