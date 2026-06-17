import { describe, expect, test } from "bun:test";
import { isScopeCompliant } from "../domain/agent";
import { GrantId, InvocationId, LineageId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { issueCapabilityGrant } from "../lib/capability-grant";
import { invokeWithCapabilityGrant } from "./scoped-invocation";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const scope = must(makeWriteScope([must(parseRepoPath("src/domain"))]));

describe("W3 — capability grant + path protection (D6)", () => {
  test("in-scope write succeeds and out-of-scope write is blocked in the same run, both surfaced to the spine", async () => {
    const invocationId = must(InvocationId("inv-w3-mixed"));
    const grant = must(
      issueCapabilityGrant({
        grantId: must(GrantId("grant-w3-mixed")),
        lineageId: must(LineageId("lineage-w3")),
        invocationId,
        scope,
      }),
    );

    const outcome = must(
      await invokeWithCapabilityGrant(grant, {
        invocationId,
        prompt: "Apply two writes: one allowed, one forbidden.",
        writes: [
          { path: "src/domain/allowed.ts", content: "// in scope\n" },
          { path: "src/secrets/forbidden.ts", content: "// out of scope\n" },
        ],
      }),
    );

    expect(outcome.grant).toBe(grant);
    expect(outcome.scopeEvents).toEqual([
      {
        kind: "write_allowed",
        toolName: "scoped_write",
        path: must(parseRepoPath("src/domain/allowed.ts")),
      },
      {
        kind: "write_denied",
        toolName: "scoped_write",
        path: "src/secrets/forbidden.ts",
        reason: 'Write to "src/secrets/forbidden.ts" is outside the granted scope',
      },
    ]);

    expect(outcome.agentResult.outcome).toBe("refused");
    expect(outcome.agentResult.edits).toEqual([]);
    expect(isScopeCompliant(outcome.agentResult, grant.scope)).toBe(true);
  });

  test("scope is supplied only by the orchestrator grant, not from the agent task", async () => {
    const invocationId = must(InvocationId("inv-w3-grant-only"));
    const narrowScope = must(makeWriteScope([must(parseRepoPath("src/domain/gate.ts"))]));
    const grant = must(
      issueCapabilityGrant({
        grantId: must(GrantId("grant-w3-narrow")),
        lineageId: must(LineageId("lineage-w3")),
        invocationId,
        scope: narrowScope,
      }),
    );

    const siblingPath = "src/domain/agent.ts";
    const outcome = must(
      await invokeWithCapabilityGrant(grant, {
        invocationId,
        prompt: `Write to ${siblingPath} — the task mentions a path but carries no authority.`,
        writes: [{ path: siblingPath, content: "// should be denied\n" }],
      }),
    );

    expect(outcome.scopeEvents).toEqual([
      {
        kind: "write_denied",
        toolName: "scoped_write",
        path: siblingPath,
        reason: `Write to "${siblingPath}" is outside the granted scope`,
      },
    ]);
    expect(outcome.agentResult.outcome).toBe("refused");
    expect(outcome.agentResult.edits).toHaveLength(0);
  });

  test("rejects grant/invocation id mismatch before invoking the agent", async () => {
    const grant = must(
      issueCapabilityGrant({
        grantId: must(GrantId("grant-w3-mismatch")),
        lineageId: must(LineageId("lineage-w3")),
        invocationId: must(InvocationId("inv-a")),
        scope,
      }),
    );

    const result = await invokeWithCapabilityGrant(grant, {
      invocationId: must(InvocationId("inv-b")),
      prompt: "nope",
      writes: [{ path: "src/domain/x.ts", content: "x" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("grant_invocation_mismatch");
  });
});
