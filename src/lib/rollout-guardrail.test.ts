import { describe, expect, test } from "bun:test";
import { type RolloutClient, runRolloutGuardrail } from "./rollout-guardrail";

describe("S2/W5 — post-launch metric guardrail (D8)", () => {
  const config = {
    flagName: "feature-x",
    metricRef: "error_rate",
    threshold: 0.05,
  };

  test("dry-run client receives arm/poll/rollback with lineage + flag ids", async () => {
    const calls: string[] = [];
    const client: RolloutClient = {
      arm: async ({ flagName, lineageId }) => {
        calls.push(`arm:${flagName}:${lineageId}`);
      },
      pollMetric: async ({ metricRef }) => {
        calls.push(`poll:${metricRef}`);
        return 0.01;
      },
      rollback: async ({ flagName, lineageId }) => {
        calls.push(`rollback:${flagName}:${lineageId}`);
      },
    };

    const result = await runRolloutGuardrail({ lineageId: "L1", config, client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("armed");
    expect(calls).toEqual(["arm:feature-x:L1", "poll:error_rate"]);
  });

  test("a simulated breach triggers rollback exactly once", async () => {
    let rollbacks = 0;
    const client: RolloutClient = {
      arm: async () => {},
      pollMetric: async () => 0.99,
      rollback: async () => {
        rollbacks += 1;
      },
    };

    const result = await runRolloutGuardrail({ lineageId: "L-breach", config, client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("rolled_back");
    if (result.value.kind !== "rolled_back") return;
    expect(result.value.metricValue).toBe(0.99);
    expect(rollbacks).toBe(1);
  });

  test("a healthy metric leaves the flag armed", async () => {
    let rolledBack = false;
    const client: RolloutClient = {
      arm: async () => {},
      pollMetric: async () => 0.01,
      rollback: async () => {
        rolledBack = true;
      },
    };

    const result = await runRolloutGuardrail({ lineageId: "L-ok", config, client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("armed");
    expect(rolledBack).toBe(false);
  });

  test("client failure degrades and never fakes green", async () => {
    const client: RolloutClient = {
      arm: async () => {
        throw new Error("flags unreachable");
      },
      pollMetric: async () => 0,
      rollback: async () => {},
    };

    const result = await runRolloutGuardrail({ lineageId: "L-fail", config, client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("degraded");
  });
});
