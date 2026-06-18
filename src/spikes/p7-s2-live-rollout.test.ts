import { describe, expect, test } from "bun:test";
import { createWebhookRolloutClient, type HttpFetch } from "../lib/live-rollout-client";
import { runRolloutGuardrail } from "../lib/rollout-guardrail";

/**
 * P7/S2 — live rollout webhook adapter boundary.
 */

describe("P7/S2 — live rollout webhook adapter", () => {
  test("webhook shim arms, polls, and rolls back on breach", async () => {
    let metric = 0.05;
    const fetchFn: HttpFetch = async (input) => {
      if (input.endsWith("/arm")) return { ok: true, status: 200, text: async () => "" };
      if (input.includes("/metric"))
        return { ok: true, status: 200, text: async () => String(metric) };
      if (input.endsWith("/rollback")) return { ok: true, status: 200, text: async () => "" };
      return { ok: false, status: 404, text: async () => "missing" };
    };
    const client = createWebhookRolloutClient({ baseUrl: "http://localhost:9999" }, fetchFn);
    const ok = await runRolloutGuardrail({
      lineageId: "L-s2",
      config: { flagName: "f", metricRef: "m", threshold: 0.1 },
      client,
    });
    expect(ok.ok && ok.value.kind === "armed").toBe(true);
    metric = 0.5;
    const breach = await runRolloutGuardrail({
      lineageId: "L-s2",
      config: { flagName: "f", metricRef: "m", threshold: 0.1 },
      client,
    });
    expect(breach.ok && breach.value.kind === "rolled_back").toBe(true);
  });
});
