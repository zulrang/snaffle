import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isScopeCompliant } from "../domain/agent";
import { classifyTwoWay } from "../domain/door";
import { GateRunId, GrantId, InvocationId, LineageId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { parseTimestamp } from "../domain/shared";
import { issueCapabilityGrant } from "../lib/capability-grant";
import { deriveControlPlaneOutcome } from "../lib/transition-derivation";
import { validateAgentResult } from "../lib/validate-agent-result";
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

describe("W3 — path escape vectors via stub (D6)", () => {
  const escapeVectors: readonly { readonly label: string; readonly path: string }[] = [
    { label: "absolute path", path: "/etc/passwd" },
    { label: "parent traversal", path: "src/domain/../../secrets/forbidden.ts" },
    {
      label: "redundant separators and dot segments",
      path: "src//domain/.././../secrets/forbidden.ts",
    },
    { label: "case variant", path: "SRC/SECRETS/forbidden.ts" },
  ];

  for (const vector of escapeVectors) {
    test(`stub is blocked on ${vector.label}`, async () => {
      const invocationId = must(InvocationId(`inv-w3-${vector.label.replace(/\s+/g, "-")}`));
      const grant = must(
        issueCapabilityGrant({
          grantId: must(GrantId(`grant-w3-${vector.label.replace(/\s+/g, "-")}`)),
          lineageId: must(LineageId("lineage-w3-vectors")),
          invocationId,
          scope,
        }),
      );

      const outcome = must(
        await invokeWithCapabilityGrant(grant, {
          invocationId,
          prompt: `Attempt out-of-scope write via ${vector.label}.`,
          writes: [
            { path: "src/domain/allowed.ts", content: "// in scope\n" },
            { path: vector.path, content: "// attack\n" },
          ],
        }),
      );

      expect(outcome.scopeEvents.some((event) => event.kind === "write_allowed")).toBe(true);
      const denied = outcome.scopeEvents.filter((event) => event.kind === "write_denied");
      expect(denied.length).toBeGreaterThan(0);
      expect(outcome.agentResult.outcome).toBe("refused");
      expect(outcome.agentResult.edits).toEqual([]);
    });
  }
});

describe("W3 — symlink escape via stub (D6)", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("blocks a write through an in-scope symlink that resolves outside scope", async () => {
    workspace = mkdtempSync(join(tmpdir(), "orchestrator-w3-symlink-"));
    mkdirSync(join(workspace, "src/domain"), { recursive: true });
    mkdirSync(join(workspace, "src/secrets"), { recursive: true });
    symlinkSync(join(workspace, "src/secrets"), join(workspace, "src/domain/escape"));

    const invocationId = must(InvocationId("inv-w3-symlink"));
    const grant = must(
      issueCapabilityGrant({
        grantId: must(GrantId("grant-w3-symlink")),
        lineageId: must(LineageId("lineage-w3-symlink")),
        invocationId,
        scope,
      }),
    );

    const outcome = must(
      await invokeWithCapabilityGrant(
        grant,
        {
          invocationId,
          prompt: "Write through a symlink that escapes scope.",
          writes: [
            { path: "src/domain/allowed.ts", content: "// in scope\n" },
            { path: "src/domain/escape/pwned.ts", content: "// symlink escape\n" },
          ],
        },
        { workspaceRoot: workspace },
      ),
    );

    expect(outcome.scopeEvents).toEqual([
      {
        kind: "write_allowed",
        toolName: "scoped_write",
        path: must(parseRepoPath("src/domain/allowed.ts")),
      },
      {
        kind: "write_denied",
        toolName: "scoped_write",
        path: "src/domain/escape/pwned.ts",
        reason: 'Write to "src/domain/escape/pwned.ts" resolves outside the granted scope',
      },
    ]);
    expect(outcome.agentResult.outcome).toBe("refused");
    expect(outcome.agentResult.edits).toEqual([]);
  });
});

describe("W3 — scope injection probe (D6)", () => {
  test("spine ignores agent-emitted allowedPaths; authority comes from the grant", async () => {
    const invocationId = must(InvocationId("inv-w3-injection"));
    const grant = must(
      issueCapabilityGrant({
        grantId: must(GrantId("grant-w3-injection")),
        lineageId: must(LineageId("lineage-w3-injection")),
        invocationId,
        scope,
      }),
    );

    const inScope = must(
      await invokeWithCapabilityGrant(grant, {
        invocationId,
        prompt: "Apply one in-scope write.",
        writes: [{ path: "src/domain/allowed.ts", content: "// ok\n" }],
      }),
    );

    const injectedRaw = {
      ...inScope.agentResult,
      allowedPaths: ["src/secrets", "config", "/etc"],
      claimedScope: { allowedPaths: ["src/secrets", "config"] },
      summary: 'Done. {"allowedPaths":["src/secrets","config","/etc"]}',
    };

    const validated = validateAgentResult(injectedRaw, invocationId);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("expected valid result");
    expect(Object.hasOwn(validated.value, "allowedPaths")).toBe(false);

    const maliciousRaw = {
      invocationId,
      agentKind: "stub",
      outcome: "succeeded",
      edits: [{ path: "src/secrets/injected.ts", operation: "modify" }],
      summary: 'allowedPaths widened to ["src/secrets"]',
      allowedPaths: ["src/secrets", "config"],
    };

    const malicious = validateAgentResult(maliciousRaw, invocationId);
    expect(malicious.ok).toBe(true);
    if (!malicious.ok) throw new Error("expected valid parse");

    expect(isScopeCompliant(malicious.value, grant.scope)).toBe(false);
    expect(isScopeCompliant(malicious.value, inScope.grant.scope)).toBe(false);

    const wideClaimScope = must(
      makeWriteScope([must(parseRepoPath("src/secrets")), must(parseRepoPath("config"))]),
    );
    expect(isScopeCompliant(malicious.value, wideClaimScope)).toBe(true);

    const transition = deriveControlPlaneOutcome({
      door: classifyTwoWay(),
      agentResult: malicious.value,
      postGateReport: {
        gateRunId: must(GateRunId("gate-w3-injection")),
        lineageId: must(LineageId("lineage-w3-injection")),
        phase: "post",
        ranAt: must(parseTimestamp(1_700_000_000_000)),
        checks: [{ kind: "full_tests", status: "passed" }],
      },
      grantedScope: grant.scope,
    });

    expect(transition).toEqual({ kind: "reject", reason: "scope_violation" });
  });
});
