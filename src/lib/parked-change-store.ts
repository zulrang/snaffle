import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LineageId } from "../domain/ids";
import type { RepoPath, WriteScope } from "../domain/scope";
import {
  type ContentHash,
  contentHashEquals,
  err,
  ok,
  parseContentHash,
  type Result,
  type Timestamp,
} from "../domain/shared";
import type { ProjectGateConfig } from "./gate-config";
import type { OrchestratorConfig } from "./orchestrator-config";
import { hashCanonicalJson } from "./provenance-hash";
import type { RegimePlan } from "./regime-plan";
import type { WorktreeWrite } from "./worktree-writes";

export const PARKED_CHANGE_DIR = ".orchestrator/parked";

export interface ParkedChangeMaterial {
  readonly lineageId: LineageId;
  readonly plan: RegimePlan;
  readonly config: OrchestratorConfig;
  readonly gateConfig: ProjectGateConfig;
  readonly scope: readonly string[];
  readonly writes: readonly WorktreeWrite[];
  readonly createdAt: Timestamp;
}

export interface ParkedChangeArtifact extends ParkedChangeMaterial {
  readonly artifactHash: ContentHash;
}

export type ParkedChangeStoreError =
  | { readonly kind: "missing_artifact"; readonly hash: string }
  | { readonly kind: "artifact_hash_mismatch"; readonly expected: string; readonly actual: string }
  | { readonly kind: "invalid_artifact"; readonly detail: string }
  | { readonly kind: "io_error"; readonly detail: string };

const artifactPayload = (material: ParkedChangeMaterial) => ({
  lineageId: String(material.lineageId),
  plan: material.plan,
  config: material.config,
  gateConfig: material.gateConfig,
  scope: [...material.scope],
  writes: material.writes.map((write) => ({ path: write.path, content: write.content })),
  createdAt: material.createdAt,
});

export const parkedChangeHash = (material: ParkedChangeMaterial): ContentHash =>
  hashCanonicalJson(artifactPayload(material));

const pathForHash = (repoRoot: string, hash: ContentHash): string =>
  join(repoRoot, PARKED_CHANGE_DIR, `${hash}.json`);

const parseArtifactPayload = (
  raw: unknown,
  hash: ContentHash,
): Result<ParkedChangeArtifact, ParkedChangeStoreError> => {
  if (typeof raw !== "object" || raw === null) {
    return err({ kind: "invalid_artifact", detail: "artifact payload must be an object" });
  }
  const item = raw as {
    lineageId?: unknown;
    plan?: unknown;
    config?: unknown;
    gateConfig?: unknown;
    scope?: unknown;
    writes?: unknown;
    createdAt?: unknown;
  };
  if (
    typeof item.lineageId !== "string" ||
    typeof item.plan !== "object" ||
    item.plan === null ||
    typeof item.config !== "object" ||
    item.config === null ||
    typeof item.gateConfig !== "object" ||
    item.gateConfig === null ||
    !Array.isArray(item.scope) ||
    !item.scope.every((entry) => typeof entry === "string") ||
    !Array.isArray(item.writes) ||
    typeof item.createdAt !== "number"
  ) {
    return err({ kind: "invalid_artifact", detail: "artifact payload has invalid fields" });
  }

  const writes: WorktreeWrite[] = [];
  for (const write of item.writes) {
    if (
      typeof write !== "object" ||
      write === null ||
      typeof (write as { path?: unknown }).path !== "string" ||
      typeof (write as { content?: unknown }).content !== "string"
    ) {
      return err({ kind: "invalid_artifact", detail: "artifact write has invalid fields" });
    }
    writes.push({
      path: (write as { path: string }).path,
      content: (write as { content: string }).content,
    });
  }

  return ok({
    artifactHash: hash,
    lineageId: item.lineageId as LineageId,
    plan: item.plan as RegimePlan,
    config: item.config as OrchestratorConfig,
    gateConfig: item.gateConfig as ProjectGateConfig,
    scope: item.scope as string[],
    writes,
    createdAt: item.createdAt as Timestamp,
  });
};

export const writeParkedChangeArtifact = (
  repoRoot: string,
  material: ParkedChangeMaterial,
): Result<ParkedChangeArtifact, ParkedChangeStoreError> => {
  const hash = parkedChangeHash(material);
  const payload = artifactPayload(material);
  try {
    mkdirSync(join(repoRoot, PARKED_CHANGE_DIR), { recursive: true });
    writeFileSync(pathForHash(repoRoot, hash), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (error) {
    return err({
      kind: "io_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return ok({ ...material, artifactHash: hash });
};

export const loadParkedChangeArtifact = (
  repoRoot: string,
  rawHash: string,
): Result<ParkedChangeArtifact, ParkedChangeStoreError> => {
  const hash = parseContentHash(rawHash);
  if (!hash.ok) return err({ kind: "invalid_artifact", detail: "invalid artifact hash" });
  const path = pathForHash(repoRoot, hash.value);
  if (!existsSync(path)) return err({ kind: "missing_artifact", hash: rawHash });

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    return err({
      kind: "io_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const artifact = parseArtifactPayload(parsed, hash.value);
  if (!artifact.ok) return artifact;

  const actual = parkedChangeHash(artifact.value);
  if (!contentHashEquals(actual, hash.value)) {
    return err({ kind: "artifact_hash_mismatch", expected: hash.value, actual });
  }

  return artifact;
};

export const scopePaths = (scope: WriteScope): readonly string[] =>
  [...scope.allowedPaths].map((path: RepoPath) => String(path)).sort((a, b) => a.localeCompare(b));
