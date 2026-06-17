import { err, ok, type Result } from "../domain/shared";

/**
 * Governance policy pack loader (D15, W9). Optional policy compiled into the
 * execution plan — absent/disabled is a no-op.
 */

export interface GovernancePolicy {
  readonly enabled: boolean;
  readonly allowedDoorOverrides: readonly string[];
  readonly requiredReviewers: readonly string[];
}

export type GovernancePolicyError = {
  readonly kind: "invalid_governance";
  readonly detail: string;
};

export const defaultGovernancePolicy = (): GovernancePolicy => ({
  enabled: false,
  allowedDoorOverrides: [],
  requiredReviewers: [],
});

const parseStringArray = (
  raw: unknown,
  label: string,
): Result<readonly string[], GovernancePolicyError> => {
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    return err({ kind: "invalid_governance", detail: `${label} must be an array of strings` });
  }
  return ok(raw as string[]);
};

export const parseGovernanceSection = (
  raw: unknown,
): Result<GovernancePolicy, GovernancePolicyError> => {
  if (raw === undefined) return ok(defaultGovernancePolicy());
  if (typeof raw !== "object" || raw === null) {
    return err({ kind: "invalid_governance", detail: "[governance] must be a table" });
  }
  const table = raw as {
    enabled?: unknown;
    allowed_door_overrides?: unknown;
    required_reviewers?: unknown;
  };
  const overrides = parseStringArray(table.allowed_door_overrides, "allowed_door_overrides");
  if (!overrides.ok) return overrides;
  const reviewers = parseStringArray(table.required_reviewers, "required_reviewers");
  if (!reviewers.ok) return reviewers;
  return ok({
    enabled: table.enabled === true,
    allowedDoorOverrides: overrides.value,
    requiredReviewers: reviewers.value,
  });
};
