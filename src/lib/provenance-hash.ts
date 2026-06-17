import type { GenerationInputs, ModelRef } from "../domain/provenance";
import type { WriteScope } from "../domain/scope";
import {
  type ContentHash,
  contentHashEquals,
  err,
  ok,
  parseContentHash,
  type Result,
} from "../domain/shared";
import type { StubInvocationMetadata } from "../pi/invoke-stub-agent";

/**
 * Content-addressed provenance hashing (D10, W7).
 *
 * Canonical JSON + SHA-256 so stored generation inputs recompute to the same
 * hashes on read-back audit.
 */

/** Raw invocation context material hashed into `GenerationInputs.contextHash`. */
export interface StubGenerationContext {
  readonly targetPath: string;
  readonly content: string;
  readonly allowedPaths: readonly string[];
}

/** Phase 1 skeleton execution plan pin (D21 thin slice). */
export const PHASE1_SKELETON_PLAN = Object.freeze({ phase: 1, kind: "skeleton" as const });

const mustHash = (raw: string): ContentHash => {
  const parsed = parseContentHash(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};

export const hashUtf8 = (value: string): ContentHash => mustHash(createSha256Hex(value));

const createSha256Hex = (value: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

export const hashCanonicalJson = (value: unknown): ContentHash => hashUtf8(canonicalJson(value));

export const computePromptHash = (prompt: string): ContentHash => hashUtf8(prompt);

export const stubGenerationContextFromTask = (input: {
  readonly targetPath: string;
  readonly content: string;
  readonly scope?: WriteScope;
}): StubGenerationContext => ({
  targetPath: input.targetPath,
  content: input.content,
  allowedPaths:
    input.scope === undefined
      ? []
      : [...input.scope.allowedPaths].map(String).sort((a, b) => a.localeCompare(b)),
});

export const computeContextHash = (context: StubGenerationContext): ContentHash =>
  hashCanonicalJson(context);

export const computePlanHash = (): ContentHash => hashCanonicalJson(PHASE1_SKELETON_PLAN);

export const modelRefFromStubMetadata = (metadata: StubInvocationMetadata): ModelRef => ({
  provider: metadata.provider,
  model: metadata.modelId,
  ...(metadata.modelVersion.length > 0 ? { version: metadata.modelVersion } : {}),
});

export const toolVersionsFromStubMetadata = (
  metadata: StubInvocationMetadata,
): Readonly<Record<string, string>> => ({
  "pi-agent-core": metadata.sdkVersions.piAgentCore,
  "pi-ai": metadata.sdkVersions.piAi,
});

export const buildGenerationInputs = (input: {
  readonly metadata: StubInvocationMetadata;
  readonly prompt: string;
  readonly context: StubGenerationContext;
  readonly temperature?: number;
  readonly seed?: number;
}): GenerationInputs => ({
  model: modelRefFromStubMetadata(input.metadata),
  promptHash: computePromptHash(input.prompt),
  contextHash: computeContextHash(input.context),
  planHash: computePlanHash(),
  temperature: input.temperature ?? 0,
  ...(input.seed === undefined ? {} : { seed: input.seed }),
  toolVersions: toolVersionsFromStubMetadata(input.metadata),
});

export const computeGenerationContentHash = (inputs: GenerationInputs): ContentHash =>
  hashCanonicalJson({
    model: inputs.model,
    promptHash: inputs.promptHash,
    contextHash: inputs.contextHash,
    planHash: inputs.planHash,
    temperature: inputs.temperature,
    ...(inputs.seed === undefined ? {} : { seed: inputs.seed }),
    toolVersions: inputs.toolVersions,
  });

export const verifyGenerationInputs = (
  inputs: GenerationInputs,
  contentHash: ContentHash,
  material: { readonly prompt: string; readonly context: StubGenerationContext },
): Result<
  { readonly contextHash: ContentHash; readonly contentHash: ContentHash },
  { readonly kind: "context_hash_mismatch" | "content_hash_mismatch" }
> => {
  const contextHash = computeContextHash(material.context);
  if (!contentHashEquals(contextHash, inputs.contextHash)) {
    return err({ kind: "context_hash_mismatch" });
  }

  const promptHash = computePromptHash(material.prompt);
  const recomputedContentHash = computeGenerationContentHash({
    ...inputs,
    promptHash,
    contextHash,
  });
  if (!contentHashEquals(recomputedContentHash, contentHash)) {
    return err({ kind: "content_hash_mismatch" });
  }

  return ok({ contextHash, contentHash });
};
