import type { AgentOutcome } from "../domain/agent";
import { type FailureCategory, type FailureVerdict, routeVerdict } from "../domain/failure";
import { failedChecks, type GateReport } from "../domain/gate";

/**
 * Typed failure evidence for deterministic classification (D4, S2/W3).
 * The classifier maps evidence to a verdict; routing is always via `routeVerdict`.
 */

export type FailureEvidence =
  | { readonly kind: "gate_report"; readonly report: GateReport }
  | { readonly kind: "scope_violation"; readonly paths: readonly string[] }
  | { readonly kind: "oracle_violation"; readonly detail?: string }
  | { readonly kind: "apply_error"; readonly detail: string }
  | { readonly kind: "agent_outcome"; readonly outcome: AgentOutcome; readonly summary?: string }
  | {
      readonly kind: "environment_fault";
      readonly detail: string;
      readonly transient?: boolean;
    }
  | {
      readonly kind: "spec_hint";
      readonly category: Extract<
        FailureCategory,
        "spec_defect" | "underspecified" | "contradictory"
      >;
    }
  | { readonly kind: "model_capability_hint"; readonly detail?: string };

const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "transient",
  "model_capability",
  "spec_defect",
  "underspecified",
  "contradictory",
  "scope_violation",
  "oracle_tampering",
  "environment",
  "apply_failure",
];

const isFailureCategory = (value: string): value is FailureCategory =>
  (FAILURE_CATEGORIES as readonly string[]).includes(value);

const classified = (category: FailureCategory, detail?: string): FailureVerdict =>
  detail === undefined
    ? { kind: "classified", category }
    : { kind: "classified", category, detail };

const classifyGateReport = (report: GateReport): FailureVerdict => {
  const failed = failedChecks(report);
  if (failed.length === 0) {
    return { kind: "malformed", reason: "gate_report with no failed checks" };
  }

  const primary = failed[0];
  if (primary === undefined) {
    return { kind: "malformed", reason: "gate_report with no failed checks" };
  }

  switch (primary.kind) {
    case "oracle_integrity":
      return classified("oracle_tampering", primary.detail);
    case "scope_integrity":
      return classified("scope_violation", primary.detail);
    case "spec_traceability":
      return classified("spec_defect", primary.detail);
    case "format":
    case "lint":
      return classified("transient", primary.detail);
    case "types":
    case "affected_tests":
    case "full_tests":
    case "contract_diff":
    case "smoke_budget":
      return classified("model_capability", primary.detail);
    default:
      return classified("model_capability", primary.detail);
  }
};

/** Classify typed evidence into a D4 verdict. */
export const classifyFailure = (evidence: FailureEvidence): FailureVerdict => {
  switch (evidence.kind) {
    case "gate_report":
      return classifyGateReport(evidence.report);
    case "scope_violation":
      return {
        kind: "classified",
        category: "scope_violation",
        detail: evidence.paths.join(", "),
      };
    case "oracle_violation":
      return classified("oracle_tampering", evidence.detail);
    case "apply_error":
      return classified("apply_failure", evidence.detail);
    case "agent_outcome":
      if (evidence.outcome === "failed") {
        return classified("model_capability", evidence.summary);
      }
      if (evidence.outcome === "refused") {
        return classified("scope_violation", evidence.summary);
      }
      return { kind: "malformed", reason: "agent_outcome evidence requires failed or refused" };
    case "environment_fault":
      return {
        kind: "classified",
        category: evidence.transient === true ? "transient" : "environment",
        detail: evidence.detail,
      };
    case "spec_hint":
      return { kind: "classified", category: evidence.category };
    case "model_capability_hint":
      return classified("model_capability", evidence.detail);
    default: {
      const _exhaustive: never = evidence;
      return { kind: "malformed", reason: `unknown evidence: ${String(_exhaustive)}` };
    }
  }
};

interface VerdictPacket {
  readonly kind?: unknown;
  readonly reason?: unknown;
  readonly category?: unknown;
  readonly detail?: unknown;
}

/** Validate an external verdict packet — malformed packets are never acted on (D4). */
export const validateFailureVerdictPacket = (packet: unknown): FailureVerdict => {
  if (typeof packet !== "object" || packet === null) {
    return { kind: "malformed", reason: "verdict packet must be an object" };
  }

  const value = packet as VerdictPacket;
  if (value.kind === "malformed") {
    return typeof value.reason === "string" && value.reason.length > 0
      ? { kind: "malformed", reason: value.reason }
      : { kind: "malformed", reason: "malformed verdict missing reason" };
  }

  if (value.kind !== "classified") {
    return { kind: "malformed", reason: "verdict packet missing kind" };
  }

  if (typeof value.category !== "string" || !isFailureCategory(value.category)) {
    return { kind: "malformed", reason: "invalid failure category" };
  }

  return classified(value.category, typeof value.detail === "string" ? value.detail : undefined);
};

/** Classify evidence and derive the routing action in one step (W3 contract). */
export const classifyAndRoute = (
  evidence: FailureEvidence,
): { readonly verdict: FailureVerdict; readonly action: ReturnType<typeof routeVerdict> } => {
  const verdict = classifyFailure(evidence);
  return { verdict, action: routeVerdict(verdict) };
};
