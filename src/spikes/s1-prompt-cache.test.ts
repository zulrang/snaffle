import { describe, expect, test } from "bun:test";
import { InvocationId } from "../domain/ids";
import { createStubFauxEnvironment, invokeStubAgent } from "../pi/invoke-stub-agent";
import { hasCacheHit } from "../pi/prompt-cache";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const SHARED_PREFIX =
  "CACHE_PREFIX: stable system-facing context that must match across invocations.";

describe("S1 — prompt cache (pi-ai cache hint + faux provider)", () => {
  test("second stub invocation with identical prefix reports a cache hit", async () => {
    const env = createStubFauxEnvironment();
    try {
      const cacheHint = {
        sessionId: "orchestrator-stub-cache-test",
        cacheRetention: "short" as const,
      };
      const sharedOptions = {
        promptCache: cacheHint,
        fauxRegistration: env.registration,
      };

      const first = must(
        await invokeStubAgent(
          {
            invocationId: must(InvocationId("inv-cache-1")),
            prompt: `${SHARED_PREFIX}\nApply edit variant A`,
            targetPath: "src/domain/gate.ts",
            content: "// first\n",
          },
          sharedOptions,
        ),
      );

      const second = must(
        await invokeStubAgent(
          {
            invocationId: must(InvocationId("inv-cache-2")),
            prompt: `${SHARED_PREFIX}\nApply edit variant B`,
            targetPath: "src/domain/gate.ts",
            content: "// second\n",
          },
          sharedOptions,
        ),
      );

      expect(first.metadata.usage).toBeDefined();
      expect(second.metadata.usage).toBeDefined();
      expect(first.metadata.usage?.cacheWrite).toBeGreaterThan(0);
      expect(first.metadata.usage?.cacheRead).toBe(0);
      expect(hasCacheHit(second.metadata.usage ?? { cacheRead: 0 })).toBe(true);
      expect(second.metadata.usage?.cacheRead).toBeGreaterThan(0);
    } finally {
      env.dispose();
    }
  });
});
