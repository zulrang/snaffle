import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { CacheRetention } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai";

/**
 * Spine-facing prompt cache hints (pi-ai StreamOptions).
 *
 * `sessionId` + `cacheRetention` are forwarded to the active provider by pi-ai /
 * pi-agent-core. Providers that do not support caching ignore these fields.
 */

export interface PromptCacheHint {
  /** Session key for provider prompt-cache affinity (required when caching is enabled). */
  readonly sessionId: string;
  /**
   * Retention preference mapped per provider (`none` | `short` | `long`).
   * Default applied by the spine when omitted: `short`.
   */
  readonly cacheRetention?: CacheRetention;
}

export const DEFAULT_CACHE_RETENTION: CacheRetention = "short";

/**
 * Provider-neutral cache hint for a lineage (D26). `sessionId` is the lineage's
 * stable affinity key — it travels out-of-band via stream options, never in the
 * prompt prefix, so prefix byte-stability and cache affinity are one choice.
 */
export const lineageCacheHint = (
  sessionId: string,
  cacheRetention: CacheRetention = DEFAULT_CACHE_RETENTION,
): PromptCacheHint => ({ sessionId, cacheRetention });

/** Merge cache hints into pi-ai stream options (used by stub agent and future spine invocations). */
export const applyPromptCacheHint = <
  T extends { sessionId?: string; cacheRetention?: CacheRetention },
>(
  options: T | undefined,
  hint: PromptCacheHint,
): T & { sessionId: string; cacheRetention: CacheRetention } => ({
  ...(options ?? ({} as T)),
  sessionId: hint.sessionId,
  cacheRetention: hint.cacheRetention ?? DEFAULT_CACHE_RETENTION,
});

/** Wrap `streamSimple` (or any StreamFn) so every LLM call carries the spine cache hint. */
export const createCachedStreamFn =
  (hint: PromptCacheHint, base: StreamFn = streamSimple): StreamFn =>
  (model, context, options) =>
    base(model, context, applyPromptCacheHint(options, hint));

/** True when usage reports a prompt-cache read (provider or faux simulation). */
export const hasCacheHit = (usage: { readonly cacheRead: number }): boolean => usage.cacheRead > 0;
