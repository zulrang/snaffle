/**
 * Deterministic failure classification and routing (D4).
 *
 * Before any retry, a failure is classified, and the category alone decides where
 * it routes. Only two categories may spend more model budget; a stronger model
 * cannot fix a wrong spec, so spec faults route to a human, not to a bigger
 * model. A verdict is only actionable if its own artifact validates — a verdict
 * carried by a malformed packet is itself a failure and is never acted on.
 */

export type FailureCategory =
  /** Flaky/intermittent — retry the same model, bounded. */
  | "transient"
  /** The model was not capable enough — escalate one tier, once. */
  | "model_capability"
  /** The spec is wrong/missing/contradictory — route to a human and back to spec. */
  | "spec_defect"
  | "underspecified"
  | "contradictory"
  /** Authority or oracle was violated — hard reject, zero retries, flag. */
  | "scope_violation"
  | "oracle_tampering"
  /** Infrastructure broke — fix the environment, not the diff. */
  | "environment"
  /** The result was legal but the orchestrator failed applying it — repair the control plane. */
  | "apply_failure";

export type RoutingAction =
  | "retry_same_tier"
  | "escalate_one_tier"
  | "route_to_human"
  | "hard_reject"
  | "fix_environment"
  | "control_plane_repair";

/**
 * A classifier output. `malformed` models the D4 guard: a verdict whose own
 * emitted artifact does not validate cannot be trusted as a classification.
 */
export type FailureVerdict =
  | { readonly kind: "classified"; readonly category: FailureCategory; readonly detail?: string }
  | { readonly kind: "malformed"; readonly reason: string };

const assertNever = (value: never): never => {
  throw new Error(`Unhandled failure category: ${String(value)}`);
};

/** Total mapping from category to its single routing action (D4). */
export const routeCategory = (category: FailureCategory): RoutingAction => {
  switch (category) {
    case "transient":
      return "retry_same_tier";
    case "model_capability":
      return "escalate_one_tier";
    case "spec_defect":
    case "underspecified":
    case "contradictory":
      return "route_to_human";
    case "scope_violation":
    case "oracle_tampering":
      return "hard_reject";
    case "environment":
      return "fix_environment";
    case "apply_failure":
      return "control_plane_repair";
    default:
      return assertNever(category);
  }
};

/**
 * Route any verdict, including a malformed one. A malformed verdict is never
 * acted on as a classification; it goes to a human (D4, Risks §9).
 */
export const routeVerdict = (verdict: FailureVerdict): RoutingAction =>
  verdict.kind === "malformed" ? "route_to_human" : routeCategory(verdict.category);

/** Only `transient` and `model_capability` may spend more model budget (D4). */
export const spendsModelBudget = (category: FailureCategory): boolean =>
  category === "transient" || category === "model_capability";

/** Only `model_capability` bumps the model tier, and only once (D4). */
export const bumpsModelTier = (category: FailureCategory): boolean =>
  category === "model_capability";
