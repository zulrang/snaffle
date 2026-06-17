import { describe, expect, test } from "bun:test";
import { ok, type Result } from "../domain/shared";

/**
 * P5/S4 — offline-testable PR adapter boundary.
 *
 * Retires the integration-surface risk: the adapter renders a commit + PR body
 * from a provenance record and posts through an INJECTED client, so tests run
 * with no live network (mirrors the faux-provider discipline). A client failure
 * degrades to the local decision queue and never blocks or fakes the gate.
 * Throwaway prototype; the real adapter is W7.
 */

interface PrSource {
  readonly lineageId: string;
  readonly summary: string;
  readonly regime: "minimal" | "full";
  readonly planHash: string;
  readonly contextHash: string;
  readonly generationId: string;
}

interface PrPayload {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
}

interface PrClient {
  open(payload: PrPayload): Promise<{ readonly url: string }>;
}

// Pure rendering: commit/PR text is derived from provenance (D10 audit trail).
const renderPr = (source: PrSource): PrPayload => ({
  branch: `snaffle/${source.lineageId}`,
  title: source.summary,
  body: [
    `Lineage: ${source.lineageId}`,
    `Regime: ${source.regime}`,
    `Plan: ${source.planHash}`,
    `Context: ${source.contextHash}`,
    `Generation: ${source.generationId}`,
  ].join("\n"),
});

type PublishResult =
  | { readonly kind: "opened"; readonly url: string }
  | { readonly kind: "degraded_to_queue"; readonly detail: string };

// The adapter NEVER throws past the gate and NEVER fabricates a merge: a remote
// failure degrades to the local queue as evidence, not a green.
const publishPr = async (
  source: PrSource,
  client: PrClient,
): Promise<Result<PublishResult, never>> => {
  const payload = renderPr(source);
  try {
    const res = await client.open(payload);
    return ok({ kind: "opened", url: res.url });
  } catch (error) {
    return ok({
      kind: "degraded_to_queue",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

const source: PrSource = {
  lineageId: "L1",
  summary: "Add the minimal in-scope change",
  regime: "minimal",
  planHash: "p".repeat(64),
  contextHash: "c".repeat(64),
  generationId: "gen-1",
};

describe("P5/S4 — PR adapter boundary", () => {
  test("a dry-run client receives a well-formed payload derived from provenance", async () => {
    const calls: PrPayload[] = [];
    const dryRun: PrClient = {
      open: async (payload) => {
        calls.push(payload);
        return { url: `dry-run://pr/${payload.branch}` };
      },
    };

    const result = await publishPr(source, dryRun);
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(1);
    const payload = calls[0] as PrPayload;
    expect(payload.branch).toBe("snaffle/L1");
    expect(payload.title.length).toBeGreaterThan(0);
    // The audit trail (provenance) is rendered into the PR body.
    expect(payload.body).toContain("L1");
    expect(payload.body).toContain(source.planHash);
    expect(payload.body).toContain(source.generationId);
  });

  test("a client failure degrades to the local queue and never fakes a merge", async () => {
    const failing: PrClient = {
      open: async () => {
        throw new Error("network unreachable");
      },
    };

    const result = await publishPr(source, failing);
    // The adapter resolves (never throws past the gate)...
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ...and the outcome is a degrade, not an "opened"/merged result.
    expect(result.value.kind).toBe("degraded_to_queue");
  });

  test("rendering is a pure function of the provenance source", () => {
    expect(renderPr(source)).toEqual(renderPr(source));
  });
});
