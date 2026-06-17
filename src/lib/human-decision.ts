import { err, ok, type Result } from "../domain/shared";
import type { LineageState } from "../domain/transition";

/**
 * Human decision resolution (D11, W5). The queue stores decisions; the control
 * plane derives the consequent state transition — never the queue itself (D19).
 */

export type HumanDecision = "approve" | "reject" | "override";

export type HumanDecisionError = { readonly kind: "not_awaiting_human" };

/** Apply a recorded human decision to a parked lineage state. */
export const applyHumanDecision = (
  currentState: LineageState,
  decision: HumanDecision,
): Result<LineageState, HumanDecisionError> => {
  if (currentState.status !== "awaiting_human") {
    return err({ kind: "not_awaiting_human" });
  }

  switch (decision) {
    case "approve":
    case "override":
      return ok({ status: "merged" });
    case "reject":
      return ok({ status: "rejected", reason: "human_rejected" });
  }
};

/** Closure requires a positive decision — an empty queue does not merge anything. */
export const closureRequiresDecision = (
  pendingCount: number,
  currentState: LineageState,
): boolean => pendingCount === 0 && currentState.status === "awaiting_human";
