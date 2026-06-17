import { ok, type Result } from "../domain/shared";

/**
 * Post-launch metric guardrail (D8, S2/W5). Arms a feature flag after merge,
 * polls an injected metrics client, and rolls back on threshold breach.
 * Never fakes green — failures degrade to logged evidence.
 */

export interface RolloutGuardrailConfig {
  readonly flagName: string;
  readonly metricRef: string;
  readonly threshold: number;
}

export interface RolloutClient {
  arm(input: { readonly flagName: string; readonly lineageId: string }): Promise<void>;
  pollMetric(input: { readonly metricRef: string }): Promise<number>;
  rollback(input: { readonly flagName: string; readonly lineageId: string }): Promise<void>;
}

export type RolloutGuardrailOutcome =
  | { readonly kind: "armed" }
  | { readonly kind: "rolled_back"; readonly metricValue: number }
  | { readonly kind: "degraded"; readonly detail: string };

export interface RolloutGuardrailInput {
  readonly lineageId: string;
  readonly config: RolloutGuardrailConfig;
  readonly client: RolloutClient;
}

/** Arm flag, poll once, rollback exactly once on breach. Does not block pre-merge gate. */
export const runRolloutGuardrail = async (
  input: RolloutGuardrailInput,
): Promise<Result<RolloutGuardrailOutcome, never>> => {
  const { config, client, lineageId } = input;
  try {
    await client.arm({ flagName: config.flagName, lineageId });
    const metricValue = await client.pollMetric({ metricRef: config.metricRef });
    if (metricValue > config.threshold) {
      await client.rollback({ flagName: config.flagName, lineageId });
      return ok({ kind: "rolled_back", metricValue });
    }
    return ok({ kind: "armed" });
  } catch (error) {
    return ok({
      kind: "degraded",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
