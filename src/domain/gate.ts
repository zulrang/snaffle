import type { GateRunId, LineageId } from "./ids";
import type { Timestamp } from "./shared";

/**
 * The deterministic acceptance gate (D8, D12).
 *
 * A single deterministic gate is the *only* thing that can block a merge, and it
 * judges against the frozen acceptance target. It runs identically before work
 * starts (PRE — refuse on a non-green tree) and after applying (POST), through
 * one shared code path, so the self-check and the authoritative gate can never
 * disagree. Checks are ordered cheapest-first so the gate fails fast on the
 * cheapest defect.
 */

/**
 * The gate's checks in cheapest-first order (D8). Phase 1 exercises a single
 * configured check (the repo's own test command); the ordering is the contract
 * the full gate runner will fill in (Phase 2).
 */
export const GATE_CHECK_ORDER = [
  "format",
  "lint",
  "types",
  "affected_tests",
  "full_tests",
  "contract_diff",
  "scope_integrity",
  "oracle_integrity",
  "spec_traceability",
  "smoke_budget",
] as const;

export type GateCheckKind = (typeof GATE_CHECK_ORDER)[number];

const CHECK_RANK: ReadonlyMap<GateCheckKind, number> = new Map(
  GATE_CHECK_ORDER.map((kind, index) => [kind, index]),
);

/** Order two checks by the canonical cheapest-first sequence. */
export const compareCheckKind = (a: GateCheckKind, b: GateCheckKind): number =>
  (CHECK_RANK.get(a) ?? 0) - (CHECK_RANK.get(b) ?? 0);

export type CheckStatus = "passed" | "failed" | "skipped";

export interface GateCheckResult {
  readonly kind: GateCheckKind;
  readonly status: CheckStatus;
  readonly detail?: string;
}

/** The gate runs identically PRE and POST through one code path (D8/W5). */
export type GatePhase = "pre" | "post";

export interface GateReport {
  readonly gateRunId: GateRunId;
  readonly lineageId: LineageId;
  readonly phase: GatePhase;
  readonly ranAt: Timestamp;
  /** Checks as executed, expected to follow `GATE_CHECK_ORDER`. */
  readonly checks: readonly GateCheckResult[];
}

export type GateOutcome = "green" | "red";

/** Green iff at least one check ran and none failed; skipped checks do not fail the gate. */
export const gateOutcome = (report: GateReport): GateOutcome => {
  if (report.checks.length === 0) return "red";
  return report.checks.some((check) => check.status === "failed") ? "red" : "green";
};

export const gatePassed = (report: GateReport): boolean => gateOutcome(report) === "green";

/** The checks that failed, in the order they ran. */
export const failedChecks = (report: GateReport): readonly GateCheckResult[] =>
  report.checks.filter((check) => check.status === "failed");

/**
 * The PRE-gate precondition (W5): the gate refuses to start work unless the tree
 * is green. (Wrap-mode characterization relaxes this to "no regression" — D16,
 * Phase 2.)
 */
export const canStartFromPre = (pre: GateReport): boolean => pre.phase === "pre" && gatePassed(pre);
