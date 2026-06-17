import { type DoorClassification, type Regime, regimeForDoor } from "../domain/door";
import type { OracleCoverageDecision } from "./oracle-coverage";

/**
 * Regime-driven phase plan (D25, seeds S4/W6).
 *
 * The door selects the regime (one-way ⇒ full, two-way ⇒ minimal); the regime
 * selects the *ceremony*, never the integrity floor. `implement` and `validate`
 * are present in both regimes — that pair carries the non-collapsible gate /
 * scope / provenance floor. The full regime adds spec + planner + dedicated
 * oracle authoring and holds for a human before merge; the minimal regime enters
 * with an inline target, reuses the frozen oracle when it covers the criteria,
 * and auto-merges on green. The spike is orthogonal — it runs in either regime
 * only when an open question must be retired.
 */

export type PipelinePhase =
  | "spec"
  | "plan"
  | "spike"
  | "oracle_authoring"
  | "implement"
  | "validate";

export type TerminalAction = "auto_merge" | "await_human";

export interface RegimePlan {
  readonly regime: Regime;
  readonly phases: readonly PipelinePhase[];
  readonly terminal: TerminalAction;
}

export interface RegimePlanOptions {
  /** Run the spike phase first when a lineage declares an open question (D25, orthogonal). */
  readonly hasOpenQuestion?: boolean;
  /**
   * Minimal regime only: the existing frozen test set demonstrably covers the
   * criteria, so the test-author pass is skipped and the oracle is reused (D25).
   * Ignored in the full regime, which always authors a dedicated oracle.
   */
  readonly oracleCovered?: boolean;
}

/** The non-collapsible floor present in every regime (D25). */
export const INTEGRITY_FLOOR_PHASES: readonly PipelinePhase[] = ["implement", "validate"];

/** Compile the ordered phase plan for a regime (D25). Pure. */
export const planForRegime = (regime: Regime, options: RegimePlanOptions = {}): RegimePlan => {
  const phases: PipelinePhase[] = [];

  if (regime === "full") {
    phases.push("spec", "plan");
  }

  if (options.hasOpenQuestion === true) {
    phases.push("spike");
  }

  // Full always authors a dedicated oracle; minimal authors one only when the
  // existing frozen set does not already cover the criteria (else it is reused).
  if (regime === "full" || options.oracleCovered !== true) {
    phases.push("oracle_authoring");
  }

  phases.push("implement", "validate");

  return {
    regime,
    phases,
    terminal: regime === "full" ? "await_human" : "auto_merge",
  };
};

export interface RegimeSelectionOptions {
  readonly hasOpenQuestion?: boolean;
}

/**
 * Select the phase plan from the lineage's door + oracle coverage (W6, D25). The
 * door fixes the regime; in the minimal regime a `reuse` coverage decision lets
 * the oracle-authoring phase collapse, while `author` keeps it. The full regime
 * always authors the oracle and holds for a human regardless of coverage —
 * `planForRegime` enforces that, so coverage can never collapse a one-way door.
 */
export const selectRegimePlan = (
  door: DoorClassification,
  coverage: OracleCoverageDecision,
  options: RegimeSelectionOptions = {},
): RegimePlan => {
  const regime = regimeForDoor(door);
  return planForRegime(regime, {
    oracleCovered: regime === "minimal" && coverage.kind === "reuse",
    ...(options.hasOpenQuestion === undefined ? {} : { hasOpenQuestion: options.hasOpenQuestion }),
  });
};
