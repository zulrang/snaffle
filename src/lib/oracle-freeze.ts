import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRepoPath } from "../domain/scope";
import { type ContentHash, err, ok, parseContentHash, type Result } from "../domain/shared";
import { hashUtf8 } from "./provenance-hash";

/**
 * Oracle freeze and integrity (D7, W7).
 *
 * Frozen oracle paths are hashed before the implementer runs; mutation attempts
 * are blocked by the same rule in gate stages and Pi extensions.
 */

export interface OracleFreezeRecord {
  readonly hash: ContentHash;
  readonly paths: Readonly<Record<string, ContentHash>>;
  readonly frozenAt: number;
}

export interface OracleDenial {
  readonly kind: "oracle_denied";
  readonly path: string;
  readonly reason: string;
}

export const hashFileUtf8 = (content: string): ContentHash => hashUtf8(content);

export const buildOracleFreezeRecord = (
  worktreeRoot: string,
  relativePaths: readonly string[],
  frozenAt: number,
): Result<OracleFreezeRecord, { readonly kind: "read_error"; readonly path: string }> => {
  const paths: Record<string, ContentHash> = {};
  for (const rel of relativePaths) {
    try {
      const content = readFileSync(join(worktreeRoot, rel), "utf8");
      paths[rel] = hashFileUtf8(content);
    } catch {
      return err({ kind: "read_error", path: rel });
    }
  }
  const hash = hashUtf8(
    Object.keys(paths)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${key}:${paths[key]}`)
      .join("|"),
  );
  return ok({ hash, paths, frozenAt });
};

export const saveOracleFreezeRecord = (
  worktreeRoot: string,
  relPath: string,
  record: OracleFreezeRecord,
): Result<void, { readonly kind: "write_error"; readonly detail: string }> => {
  try {
    mkdirSync(dirname(join(worktreeRoot, relPath)), { recursive: true });
    writeFileSync(join(worktreeRoot, relPath), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return ok(undefined);
  } catch (error) {
    return err({
      kind: "write_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

export const loadOracleFreezeRecord = (
  worktreeRoot: string,
  relPath: string,
): Result<
  OracleFreezeRecord | undefined,
  { readonly kind: "parse_error"; readonly detail: string }
> => {
  try {
    const raw = readFileSync(join(worktreeRoot, relPath), "utf8");
    const parsed = JSON.parse(raw) as {
      hash?: unknown;
      paths?: unknown;
      frozenAt?: unknown;
    };
    if (
      typeof parsed.hash !== "string" ||
      typeof parsed.paths !== "object" ||
      parsed.paths === null
    ) {
      return err({ kind: "parse_error", detail: "invalid oracle freeze shape" });
    }
    const hash = parseContentHash(parsed.hash);
    if (!hash.ok) return err({ kind: "parse_error", detail: "invalid oracle freeze hash" });

    const paths: Record<string, ContentHash> = {};
    for (const [key, value] of Object.entries(parsed.paths as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const parsedHash = parseContentHash(value);
      if (parsedHash.ok) paths[key] = parsedHash.value;
    }

    return ok({
      hash: hash.value,
      paths,
      frozenAt: typeof parsed.frozenAt === "number" ? parsed.frozenAt : 0,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ok(undefined);
    return err({
      kind: "parse_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Block mutation tools targeting a frozen oracle path (D7). */
export const checkOracleMutationAllowed = (
  freeze: OracleFreezeRecord,
  toolName: string,
  rawPath: string,
): OracleDenial | undefined => {
  if (toolName !== "write" && toolName !== "edit" && toolName !== "scoped_write") {
    return undefined;
  }

  const parsed = parseRepoPath(rawPath);
  if (!parsed.ok) return undefined;

  if (Object.hasOwn(freeze.paths, parsed.value)) {
    return {
      kind: "oracle_denied",
      path: parsed.value,
      reason: `Oracle path "${parsed.value}" is frozen and read-only (D7)`,
    };
  }

  return undefined;
};

/** Gate-stage oracle integrity: re-hash frozen paths and detect drift. */
export const verifyOracleIntegrity = (
  worktreeRoot: string,
  freeze: OracleFreezeRecord,
): Result<void, { readonly kind: "oracle_touched"; readonly path: string }> => {
  for (const [rel, expectedHash] of Object.entries(freeze.paths)) {
    try {
      const content = readFileSync(join(worktreeRoot, rel), "utf8");
      const current = hashFileUtf8(content);
      if (current !== expectedHash) {
        return err({ kind: "oracle_touched", path: rel });
      }
    } catch {
      return err({ kind: "oracle_touched", path: rel });
    }
  }
  return ok(undefined);
};
