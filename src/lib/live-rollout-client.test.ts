import { describe, expect, test } from "bun:test";
import { createWebhookRolloutClient, type HttpFetch } from "./live-rollout-client";
import { runRolloutGuardrail } from "./rollout-guardrail";

describe("W2 — live rollout webhook client (D8)", () => {
  test("arm/poll/rollback hit webhook endpoints; breach rolls back once", async () => {
    const log: string[] = [];
    let metric = 0.01;
    const fetchFn: HttpFetch = async (input, init) => {
      log.push(`${init?.method ?? "GET"} ${input}`);
      if (input.endsWith("/arm")) return { ok: true, status: 200, text: async () => "" };
      if (input.includes("/metric"))
        return { ok: true, status: 200, text: async () => String(metric) };
      if (input.endsWith("/rollback")) return { ok: true, status: 200, text: async () => "" };
      return { ok: false, status: 404, text: async () => "missing" };
    };

    const client = createWebhookRolloutClient({ baseUrl: "http://rollout.test" }, fetchFn);
    const healthy = await runRolloutGuardrail({
      lineageId: "L-live",
      config: { flagName: "f", metricRef: "err", threshold: 0.1 },
      client,
    });
    expect(healthy.ok && healthy.value.kind === "armed").toBe(true);

    metric = 0.99;
    const breach = await runRolloutGuardrail({
      lineageId: "L-live",
      config: { flagName: "f", metricRef: "err", threshold: 0.1 },
      client,
    });
    expect(breach.ok && breach.value.kind === "rolled_back").toBe(true);
    expect(log.some((entry) => entry.includes("/rollback"))).toBe(true);
  });
});
