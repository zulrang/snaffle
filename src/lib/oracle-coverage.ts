/**
 * Oracle-reuse coverage check (W6, D25). In the minimal regime the runner may
 * reuse an already-frozen oracle when it covers every acceptance criterion,
 * skipping the test-author pass. The decision is deterministic and conservative:
 * absent or incomplete coverage falls back to authoring (cut line 4). Integrity
 * — separate authoring + freeze before the implementer — holds either way; only
 * the ceremony-collapse optimization is gated on coverage.
 */

export type OracleCoverageDecision =
  | { readonly kind: "reuse"; readonly coveredCriteria: readonly string[] }
  | {
      readonly kind: "author";
      readonly reason: "no_frozen_oracle" | "uncovered_criteria";
      readonly uncovered: readonly string[];
    };

export interface OracleCoverageInput {
  /** Acceptance criteria ids the change must satisfy. */
  readonly requiredCriteria: readonly string[];
  /** Criteria ids the existing frozen oracle already covers (absent = no oracle). */
  readonly frozenOracleCriteria?: readonly string[];
}

export const decideOracleCoverage = (input: OracleCoverageInput): OracleCoverageDecision => {
  const frozen = input.frozenOracleCriteria;
  if (frozen === undefined || frozen.length === 0) {
    return { kind: "author", reason: "no_frozen_oracle", uncovered: [...input.requiredCriteria] };
  }

  const covered = new Set(frozen);
  const uncovered = input.requiredCriteria.filter((id) => !covered.has(id));
  if (uncovered.length > 0) {
    return { kind: "author", reason: "uncovered_criteria", uncovered };
  }

  return { kind: "reuse", coveredCriteria: [...input.requiredCriteria] };
};
