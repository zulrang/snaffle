import type { GrantId, InvocationId, LineageId } from "./ids";
import type { Brand, Result, Timestamp } from "./shared";
import { err, ok } from "./shared";

/**
 * Capability / write-scope model (D6).
 *
 * Authority comes from the control plane, never from content. A scope is a set
 * of repo-relative path prefixes the orchestrator is willing to let an agent
 * write to; nothing the agent reads can widen it. Path containment and scope
 * overlap are pure, deterministic predicates — the same `lib/` rule enforced
 * both by the orchestrator and by the Pi path-protection extension, and reused
 * for declared-scope conflict detection (D20).
 */

// ---------------------------------------------------------------------------
// RepoPath — a normalized, repo-relative POSIX path
// ---------------------------------------------------------------------------

export type RepoPath = Brand<string, "RepoPath">;

export type RepoPathError =
  | { readonly kind: "empty_path"; readonly value: string }
  | { readonly kind: "absolute_path"; readonly value: string }
  | { readonly kind: "path_escapes_root"; readonly value: string };

/**
 * Parse a repo-relative path into a normalized form: forward slashes, no leading
 * or trailing slash, no `.` segments, and crucially no `..` escape. Rejecting
 * `..` at construction is what makes containment checks trustworthy downstream.
 */
export const parseRepoPath = (raw: string): Result<RepoPath, RepoPathError> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return err({ kind: "empty_path", value: raw });
  if (trimmed.startsWith("/")) return err({ kind: "absolute_path", value: raw });

  const segments: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return err({ kind: "path_escapes_root", value: raw });
    segments.push(segment);
  }
  if (segments.length === 0) return err({ kind: "empty_path", value: raw });

  return ok(segments.join("/") as RepoPath);
};

/** Split a normalized path into segments (safe: no empties after normalization). */
const segmentsOf = (path: RepoPath): readonly string[] => path.split("/");

/**
 * True when `candidate` is the prefix path itself or nested beneath it. Matching
 * is segment-wise so `src/foo` does not match `src/foobar`.
 */
export const pathWithinPrefix = (candidate: RepoPath, prefix: RepoPath): boolean => {
  const c = segmentsOf(candidate);
  const p = segmentsOf(prefix);
  if (c.length < p.length) return false;
  return p.every((segment, i) => segment === c[i]);
};

// ---------------------------------------------------------------------------
// WriteScope — a non-empty set of allowed path prefixes
// ---------------------------------------------------------------------------

export interface WriteScope {
  readonly allowedPaths: readonly RepoPath[];
}

export interface EmptyScopeError {
  readonly kind: "empty_scope";
}

export const makeWriteScope = (
  allowedPaths: readonly RepoPath[],
): Result<WriteScope, EmptyScopeError> => {
  if (allowedPaths.length === 0) return err({ kind: "empty_scope" });
  return ok({ allowedPaths });
};

/** Is a candidate write permitted under this scope? (The D6 enforcement check.) */
export const pathWithinScope = (scope: WriteScope, candidate: RepoPath): boolean =>
  scope.allowedPaths.some((prefix) => pathWithinPrefix(candidate, prefix));

/**
 * Do two declared scopes overlap? Used to back-pressure lineages whose write
 * scopes collide (D20). Overlap holds if any prefix of one contains, or is
 * contained by, a prefix of the other.
 */
export const scopesOverlap = (a: WriteScope, b: WriteScope): boolean =>
  a.allowedPaths.some((pa) =>
    b.allowedPaths.some((pb) => pathWithinPrefix(pa, pb) || pathWithinPrefix(pb, pa)),
  );

// ---------------------------------------------------------------------------
// CapabilityGrant — authority issued per agent invocation by the orchestrator
// ---------------------------------------------------------------------------

export interface CapabilityGrant {
  readonly grantId: GrantId;
  readonly lineageId: LineageId;
  /** The specific agent invocation this authority is scoped to. */
  readonly invocationId: InvocationId;
  readonly scope: WriteScope;
  readonly issuedAt: Timestamp;
}
