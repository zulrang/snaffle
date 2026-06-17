import type { ModelRef } from "./orchestrator-config";
import { MODEL_TIERS, type ModelTier, type OrchestratorConfig } from "./orchestrator-config";

export type { ModelTier } from "./orchestrator-config";

/** Resolve a tier to a provider-neutral model ref from project config (D18, S4/W7). */
export const resolveModelTier = (tier: ModelTier, config: OrchestratorConfig): ModelRef =>
  config.tiers[tier];

/** Bump exactly one tier; returns null when already at heavy. */
export const escalateTier = (tier: ModelTier): ModelTier | null => {
  const index = MODEL_TIERS.indexOf(tier);
  if (index < 0 || index >= MODEL_TIERS.length - 1) return null;
  return MODEL_TIERS[index + 1] ?? null;
};
