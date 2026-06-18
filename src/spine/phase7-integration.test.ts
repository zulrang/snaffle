import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageId } from "../domain/ids";
import { createWebhookRolloutClient, type HttpFetch } from "../lib/live-rollout-client";
import { defaultOrchestratorConfig } from "../lib/orchestrator-config";
import { loadLastRollout } from "../lib/rollout-store";
import { runPostMergeRolloutIfEnabled } from "./spine-wiring";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W9 — Phase 7 production loop (offline mirror)", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("webhook rollout persists last outcome and records metric escape on breach", async () => {
    workspace = mkdtempSync(join(tmpdir(), "w9-p7-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const fetchFn: HttpFetch = async (input) => {
      if (input.endsWith("/arm")) return { ok: true, status: 200, text: async () => "" };
      if (input.includes("/metric")) return { ok: true, status: 200, text: async () => "0.99" };
      if (input.endsWith("/rollback")) return { ok: true, status: 200, text: async () => "" };
      return { ok: false, status: 404, text: async () => "missing" };
    };
    const client = createWebhookRolloutClient({ baseUrl: "http://rollout.test" }, fetchFn);
    const lineageId = must(LineageId("L-w9-p7"));
    const config = {
      ...defaultOrchestratorConfig(),
      rollout: {
        enabled: true,
        adapter: "live" as const,
        flagName: "f",
        metricRef: "err",
        threshold: 0.1,
        pollIntervalMs: 1000,
        webhookBaseUrl: "http://rollout.test",
      },
    };

    const outcome = await runPostMergeRolloutIfEnabled(workspace, config, lineageId, client);
    expect(outcome?.kind).toBe("rolled_back");
    const last = must(loadLastRollout(workspace));
    expect(last?.outcome.kind).toBe("rolled_back");
    expect(last?.operatorAcknowledged).toBe(false);
  });
});
