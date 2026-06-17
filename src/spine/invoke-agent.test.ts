import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { InvocationId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { AGENT_DEFINITIONS } from "../lib/agents";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { invokeAgent } from "./invoke-agent";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");

// Provider-neutral config swap proves tier resolution is not vendor-hardcoded (D18).
const config = {
  ...defaultOrchestratorConfig(),
  tiers: {
    light: { provider: "anthropic", model: "claude-light" },
    mid: { provider: "anthropic", model: "claude-mid" },
    heavy: { provider: "anthropic", model: "claude-heavy" },
  },
};

describe("W2 — agent definitions (D3/D6/D18)", () => {
  test("the registry encodes tier and scope policy per agent", () => {
    expect(AGENT_DEFINITIONS.spec.tier).toBe("heavy");
    expect(AGENT_DEFINITIONS.spiker.scopePolicy).toBe("throwaway");
    expect(AGENT_DEFINITIONS.test_author.scopePolicy).toBe("frozen_tests_only");
    expect(AGENT_DEFINITIONS.implementer.skills).toContain("implementation");
  });

  test("the implementer composes its skill, resolves its tier via config, and returns a validated result", async () => {
    const scope = must(makeWriteScope([must(parseRepoPath("src/lib"))]));
    const outcome = must(
      await invokeAgent({
        definition: AGENT_DEFINITIONS.implementer,
        invocationId: must(InvocationId("inv-w2-impl")),
        prompt: "Apply a trivial in-scope edit.",
        writes: [{ path: "src/lib/w2-marker.ts", content: "// w2\n" }],
        scope,
        config,
        repoRoot,
      }),
    );

    // Composed skill doctrine is in the prefix (D2/D26).
    expect(outcome.systemPrompt).toContain("Implementation skill");
    // Tier resolved provider-neutrally (D18) — mid tier from the swapped config.
    expect(outcome.modelRef.provider).toBe("anthropic");
    expect(outcome.modelRef.model).toBe("claude-mid");
    expect(outcome.metadata.provider).toBe("anthropic");
    // Result is tagged with the real agent kind, not the stub (D19 evidence).
    expect(outcome.agentResult.agentKind).toBe("implementer");
    expect(outcome.agentResult.outcome).toBe("succeeded");
    expect(String(outcome.agentResult.edits[0]?.path)).toBe("src/lib/w2-marker.ts");
  });

  test("the test author is confined to its granted (frozen-test) scope", async () => {
    const testScope = must(makeWriteScope([must(parseRepoPath("tests"))]));
    const outcome = must(
      await invokeAgent({
        definition: AGENT_DEFINITIONS.test_author,
        invocationId: must(InvocationId("inv-w2-ta-bad")),
        prompt: "Author the oracle — but try to also touch the feature.",
        writes: [{ path: "src/lib/feature.ts", content: "// not allowed\n" }],
        scope: testScope,
        config,
        repoRoot,
      }),
    );

    expect(outcome.agentResult.agentKind).toBe("test_author");
    expect(outcome.agentResult.outcome).toBe("refused");
    expect(outcome.scopeEvents.some((event) => event.kind === "write_denied")).toBe(true);
  });
});
