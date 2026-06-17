import { describe, expect, test } from "bun:test";
import { type RolloutClient, runRolloutGuardrail } from "../lib/rollout-guardrail";

/**
 * P6/S2 — post-launch metric guardrail boundary.
 *
 * Retires long-loop acceptance risk: injected client arm/poll/rollback contract
 * with no live network. Real implementation is lib/rollout-guardrail.ts (W5).
 */

describe("P6/S2 — metric guardrail boundary", () => {
  test("breach rolls back once; healthy metric stays armed", async () => {
    const config = { flagName: "f", metricRef: "m", threshold: 0.1 };
    let rollbacks = 0;

    const breachClient: RolloutClient = {
      arm: async () => {},
      pollMetric: async () => 0.5,
      rollback: async () => {
        rollbacks += 1;
      },
    };
    const breach = await runRolloutGuardrail({
      lineageId: "L",
      config,
      client: breachClient,
    });
    expect(breach.ok && breach.value.kind === "rolled_back").toBe(true);
    expect(rollbacks).toBe(1);

    const okClient: RolloutClient = {
      arm: async () => {},
      pollMetric: async () => 0.01,
      rollback: async () => {
        rollbacks += 1;
      },
    };
    const ok = await runRolloutGuardrail({ lineageId: "L2", config, client: okClient });
    expect(ok.ok && ok.value.kind === "armed").toBe(true);
    expect(rollbacks).toBe(1);
  });
});
