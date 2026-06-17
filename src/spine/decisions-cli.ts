import { join } from "node:path";
import { LineageId } from "../domain/ids";
import { err, ok, parseTimestamp, type Result } from "../domain/shared";
import type { LineageState } from "../domain/transition";
import {
  DECISION_DB_DIR,
  DECISION_DB_FILE,
  type DecisionItem,
  openDecisionQueueStore,
} from "../lib/decision-queue";

/**
 * W8 — local CLI surface for the batched human decision queue (D11).
 */

export type DecisionsCommand = "list" | "approve" | "reject";

export type DecisionsCliError =
  | { readonly kind: "invalid_lineage"; readonly detail: string }
  | { readonly kind: "not_found"; readonly lineageId: string }
  | { readonly kind: "not_pending"; readonly lineageId: string }
  | { readonly kind: "queue_error"; readonly detail: string };

export interface DecisionsListOutcome {
  readonly pending: readonly DecisionItem[];
  readonly count: number;
}

export interface DecisionsRecordOutcome {
  readonly item: DecisionItem;
  readonly nextState: LineageState;
}

const decisionDbPath = (repoRoot: string): string =>
  join(repoRoot, DECISION_DB_DIR, DECISION_DB_FILE);

export const listPendingDecisions = (
  repoRoot: string,
): Result<DecisionsListOutcome, DecisionsCliError> => {
  const store = openDecisionQueueStore(decisionDbPath(repoRoot));
  try {
    const pending = store.listPending();
    if (!pending.ok) return err({ kind: "queue_error", detail: JSON.stringify(pending.error) });
    const count = store.pendingCount();
    if (!count.ok) return err({ kind: "queue_error", detail: JSON.stringify(count.error) });
    return ok({ pending: pending.value, count: count.value });
  } finally {
    store.close();
  }
};

export const recordDecisionForLineage = (
  repoRoot: string,
  rawLineageId: string,
  command: Exclude<DecisionsCommand, "list">,
): Result<DecisionsRecordOutcome, DecisionsCliError> => {
  const lineageId = LineageId(rawLineageId);
  if (!lineageId.ok) return err({ kind: "invalid_lineage", detail: rawLineageId });

  const store = openDecisionQueueStore(decisionDbPath(repoRoot));
  try {
    const item = store.getByLineageId(lineageId.value);
    if (!item.ok) return err({ kind: "queue_error", detail: JSON.stringify(item.error) });
    if (item.value === undefined) return err({ kind: "not_found", lineageId: rawLineageId });
    if (item.value.decidedAt !== undefined) {
      return err({ kind: "not_pending", lineageId: rawLineageId });
    }

    const at = parseTimestamp(Date.now());
    if (!at.ok) return err({ kind: "queue_error", detail: "invalid timestamp" });

    const recorded = store.recordDecision({
      decisionId: item.value.decisionId,
      decision: command === "approve" ? "approve" : "reject",
      currentState: { status: "awaiting_human" },
      decidedAt: at.value,
    });
    if (!recorded.ok) return err({ kind: "queue_error", detail: JSON.stringify(recorded.error) });
    return ok(recorded.value);
  } finally {
    store.close();
  }
};
