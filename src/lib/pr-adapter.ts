import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../domain/shared";

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

export const PR_FAILURE_QUEUE_DIR = ".snaffle/pr-failures";

export interface PrFailureQueueItem {
  readonly source: PrSource;
  readonly payload: PrPayload;
  readonly detail: string;
  readonly queuedAt: number;
}

export type PrFailureQueueError = { readonly kind: "queue_write"; readonly detail: string };

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

export const enqueuePrFailure = (
  repoRoot: string,
  source: PrSource,
  result: Extract<PublishPrResult, { readonly kind: "degraded_to_queue" }>,
  queuedAt: number,
): Result<{ readonly path: string }, PrFailureQueueError> => {
  const dir = join(repoRoot, PR_FAILURE_QUEUE_DIR);
  const path = join(dir, `${source.lineageId}.json`);
  const item: PrFailureQueueItem = {
    source,
    payload: renderPrPayload(source),
    detail: result.detail,
    queuedAt,
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(item, null, 2)}\n`, "utf8");
    return ok({ path });
  } catch (error) {
    return err({
      kind: "queue_write",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
