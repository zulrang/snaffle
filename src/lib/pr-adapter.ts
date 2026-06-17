import { ok, type Result } from "../domain/shared";

/**
 * GitHub PR adapter + commit scaffolder (D11, W7). Renders commit/PR payload from
 * provenance and posts through an injected client — no live network in tests.
 * Remote failure degrades to the local queue; never blocks or fakes the gate.
 */

export interface PrSource {
  readonly lineageId: string;
  readonly summary: string;
  readonly regime: "minimal" | "full";
  readonly planHash: string;
  readonly contextHash: string;
  readonly generationId: string;
}

export interface PrPayload {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
}

export interface PrClient {
  open(payload: PrPayload): Promise<{ readonly url: string }>;
}

export type PublishPrResult =
  | { readonly kind: "opened"; readonly url: string }
  | { readonly kind: "degraded_to_queue"; readonly detail: string };

export const renderPrPayload = (source: PrSource): PrPayload => ({
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

/** Publish through the injected client; never throws past the gate. */
export const publishPr = async (
  source: PrSource,
  client: PrClient,
): Promise<Result<PublishPrResult, never>> => {
  const payload = renderPrPayload(source);
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
