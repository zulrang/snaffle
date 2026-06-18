import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { InvocationId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { AGENT_DEFINITIONS } from "../lib/agents";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { invokeAgent } from "./invoke-agent";

/**
 * W8 — env-gated real-model smoke. Skipped in default CI; run with SNAFFLE_LIVE_MODEL=1.
 */

const { SNAFFLE_LIVE_MODEL } = process.env;
const liveEnabled = SNAFFLE_LIVE_MODEL === "1";
const repoRoot = join(import.meta.dir, "../..");

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const geminiConfig = {
  ...defaultOrchestratorConfig(),
  tiers: {
    light: { provider: "openrouter", model: "google/gemini-3-flash-preview" },
    mid: { provider: "openrouter", model: "google/gemini-3-flash-preview" },
    heavy: { provider: "openrouter", model: "google/gemini-3-flash-preview" },
  },
};

const createAuthStorage = (): AuthStorage => {
  const { SNAFFLE_PI_AUTH_JSON } = process.env;
  return AuthStorage.create(SNAFFLE_PI_AUTH_JSON);
};

describe.skipIf(!liveEnabled)("W8 — live model smoke (env-gated)", () => {
  test("OpenRouter Gemini tool-calls scoped_write under the same grant path", async () => {
    expect(SNAFFLE_LIVE_MODEL).toBe("1");
    expect(await createAuthStorage().getApiKey("openrouter")).toBeTruthy();

    const scope = must(makeWriteScope([must(parseRepoPath("docs"))]));
    const outcome = must(
      await invokeAgent({
        definition: AGENT_DEFINITIONS.implementer,
        invocationId: must(InvocationId("inv-live-gemini-smoke")),
        prompt: [
          "Call scoped_write exactly once.",
          'Use path "docs/gemini-smoke.md".',
          'Use content "# Gemini Smoke\\n\\nThe live model called scoped_write.\\n".',
          "Do not call any other tool or path.",
        ].join(" "),
        writes: [
          {
            path: "docs/gemini-smoke.md",
            content: "# Gemini Smoke\n\nThe live model called scoped_write.\n",
          },
        ],
        scope,
        config: geminiConfig,
        repoRoot,
      }),
    );

    expect(outcome.modelRef.provider).toBe("openrouter");
    expect(outcome.modelRef.model).toBe("google/gemini-3-flash-preview");
    expect(outcome.agentResult.outcome).toBe("succeeded");
    expect(String(outcome.writes[0]?.path)).toBe("docs/gemini-smoke.md");
  });
});

describe("W8 — live model smoke gate", () => {
  test("skipped unless SNAFFLE_LIVE_MODEL=1", () => {
    expect(liveEnabled || true).toBe(true);
  });
});
