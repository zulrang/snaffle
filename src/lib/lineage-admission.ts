import type { AttemptId, LineageId, WorktreeId } from "../domain/ids";
import { AttemptId as makeAttemptId, WorktreeId as makeWorktreeId } from "../domain/ids";
import { err, ok, type Result } from "../domain/shared";
import type { LineageState, PipelinePhase } from "../domain/transition";

/**
 * Lineage admission state (W2, D20). The scheduler produces `admitted` when a
 * lineage clears conflict admission; `running` begins only after admission.
 */

export interface LineageAdmission {
  readonly attemptId: AttemptId;
  readonly worktreeId: WorktreeId;
  readonly state: LineageState;
}

export type LineageAdmissionError = { readonly kind: "invalid_id"; readonly detail: string };

/** Produce the admitted state and bind attempt/worktree ids for the run. */
export const admitLineage = (input: {
  readonly lineageId: LineageId;
  readonly attemptSeq: number;
  readonly worktreeSeq: number;
}): Result<LineageAdmission, LineageAdmissionError> => {
  const attemptId = makeAttemptId(`${String(input.lineageId)}-attempt-${input.attemptSeq}`);
  const worktreeId = makeWorktreeId(`${String(input.lineageId)}-wt-${input.worktreeSeq}`);
  if (!attemptId.ok) return err({ kind: "invalid_id", detail: "attemptId" });
  if (!worktreeId.ok) return err({ kind: "invalid_id", detail: "worktreeId" });

  return ok({
    attemptId: attemptId.value,
    worktreeId: worktreeId.value,
    state: { status: "admitted" },
  });
};

export const admittedState = (): LineageState => ({ status: "admitted" });

export const runningFromAdmitted = (phase: PipelinePhase): LineageState => ({
  status: "running",
  phase,
});

export const isAdmitted = (state: LineageState): boolean => state.status === "admitted";
