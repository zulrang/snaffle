import { describe, expect, test } from "bun:test";
import { defaultGovernancePolicy, parseGovernanceSection } from "./governance-policy";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W9 — governance policy pack (D15)", () => {
  test("absent section defaults to disabled no-op", () => {
    expect(must(parseGovernanceSection(undefined))).toEqual(defaultGovernancePolicy());
  });

  test("present section yields typed policy object", () => {
    const policy = must(
      parseGovernanceSection({
        enabled: true,
        allowed_door_overrides: ["money"],
        required_reviewers: ["alice"],
      }),
    );
    expect(policy.enabled).toBe(true);
    expect(policy.allowedDoorOverrides).toEqual(["money"]);
    expect(policy.requiredReviewers).toEqual(["alice"]);
  });
});
