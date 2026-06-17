import { describe, expect, test } from "bun:test";
import { GrantId, InvocationId, LineageId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseTimestamp } from "../domain/shared";
import { issueCapabilityGrant } from "./capability-grant";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("capability grant — unit cases", () => {
  test("issues a grant with orchestrator-supplied scope", () => {
    const scope = must(makeWriteScope([must(parseRepoPath("src/domain"))]));
    const grant = must(
      issueCapabilityGrant({
        grantId: must(GrantId("grant-1")),
        lineageId: must(LineageId("lineage-1")),
        invocationId: must(InvocationId("inv-1")),
        scope,
        issuedAt: 1_700_000_000_000,
      }),
    );

    expect(grant.scope).toBe(scope);
    expect(grant.grantId).toBe(must(GrantId("grant-1")));
    expect(grant.invocationId).toBe(must(InvocationId("inv-1")));
    expect(grant.issuedAt).toBe(must(parseTimestamp(1_700_000_000_000)));
  });
});
