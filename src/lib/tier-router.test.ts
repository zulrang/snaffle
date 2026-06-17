import { describe, expect, test } from "bun:test";
import { defaultOrchestratorConfig } from "./orchestrator-config";
import { escalateTier, resolveModelTier } from "./tier-router";

describe("S4/W7 — provider-neutral tier resolution (D18)", () => {
  const config = defaultOrchestratorConfig();

  test("each tier resolves from config", () => {
    expect(resolveModelTier("light", config)).toEqual(config.tiers.light);
    expect(resolveModelTier("mid", config)).toEqual(config.tiers.mid);
    expect(resolveModelTier("heavy", config)).toEqual(config.tiers.heavy);
  });

  test("escalate_one_tier bumps exactly one step and stops at heavy", () => {
    expect(escalateTier("light")).toBe("mid");
    expect(escalateTier("mid")).toBe("heavy");
    expect(escalateTier("heavy")).toBeNull();
  });

  test("config swap changes model without code change", () => {
    const swapped = {
      ...config,
      tiers: {
        light: { provider: "openai", model: "gpt-mini" },
        mid: { provider: "openai", model: "gpt-main" },
        heavy: { provider: "openai", model: "gpt-max" },
      },
    };
    expect(resolveModelTier("light", swapped).provider).toBe("openai");
    expect(resolveModelTier("light", config).provider).toBe("faux");
  });
});
