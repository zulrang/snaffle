import type { RolloutClient } from "./rollout-guardrail";

/**
 * Live rollout adapter (D8, W2). HTTP webhook shim behind RolloutClient — one backend
 * for v1; vendor-specific adapters can wrap the same contract later.
 */

export interface RolloutWebhookConfig {
  readonly baseUrl: string;
}

export type HttpFetch = (
  input: string,
  init?: { readonly method?: string; readonly body?: string },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}>;

const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

export const createWebhookRolloutClient = (
  config: RolloutWebhookConfig,
  fetchFn: HttpFetch,
): RolloutClient => ({
  arm: async ({ flagName, lineageId }) => {
    const res = await fetchFn(joinUrl(config.baseUrl, "/arm"), {
      method: "POST",
      body: JSON.stringify({ flagName, lineageId }),
    });
    if (!res.ok) {
      throw new Error(`arm failed: ${res.status} ${await res.text()}`);
    }
  },
  pollMetric: async ({ metricRef }) => {
    const res = await fetchFn(
      joinUrl(config.baseUrl, `/metric?ref=${encodeURIComponent(metricRef)}`),
    );
    if (!res.ok) {
      throw new Error(`poll failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.text();
    const value = Number(body.trim());
    if (!Number.isFinite(value)) {
      throw new Error(`poll returned non-numeric metric: ${body.slice(0, 100)}`);
    }
    return value;
  },
  rollback: async ({ flagName, lineageId }) => {
    const res = await fetchFn(joinUrl(config.baseUrl, "/rollback"), {
      method: "POST",
      body: JSON.stringify({ flagName, lineageId }),
    });
    if (!res.ok) {
      throw new Error(`rollback failed: ${res.status} ${await res.text()}`);
    }
  },
});
