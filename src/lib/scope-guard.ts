import { lstatSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { parseRepoPath, pathWithinScope, type RepoPath, type WriteScope } from "../domain/scope";
import { err, ok, type Result } from "../domain/shared";
import {
  checkOracleMutationAllowed,
  type OracleDenial,
  type OracleFreezeRecord,
} from "./oracle-freeze";

/**
 * Deterministic write-scope enforcement (D6, D12).
 *
 * The same rules run in three places: the orchestrator's pre-check over agent
 * results, pi-agent-core's `beforeToolCall`, and the Pi extension's
 * `tool_call` handler. One implementation, no drift.
 */

export const MUTATION_TOOL_NAMES = ["write", "edit", "scoped_write"] as const;
export type MutationToolName = (typeof MUTATION_TOOL_NAMES)[number];

/** Tools allowed without scope enforcement under a grant (read-only / non-mutating). */
export const READ_ONLY_TOOL_NAMES = [] as const;

export interface ScopeDenial {
  readonly kind: "scope_denied";
  readonly toolName: string;
  readonly path: string;
  readonly reason: string;
}

const isMutationTool = (toolName: string): toolName is MutationToolName =>
  (MUTATION_TOOL_NAMES as readonly string[]).includes(toolName);

const isReadOnlyTool = (toolName: string): boolean =>
  (READ_ONLY_TOOL_NAMES as readonly string[]).includes(toolName);

/** Extract the target path from a mutation tool's validated arguments. */
export const extractWritePath = (toolName: string, args: unknown): string | undefined => {
  if (!isMutationTool(toolName)) return undefined;
  if (typeof args !== "object" || args === null || !("path" in args)) return undefined;
  const path = (args as { path: unknown }).path;
  return typeof path === "string" ? path : undefined;
};

const isInsideRoot = (rootReal: string, candidateReal: string): boolean => {
  const rel = relative(rootReal, candidateReal);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
};

/**
 * Walk a repo-relative path on disk, following symlink hops. Returns the
 * canonical repo-relative target used for scope checks after normalization.
 */
export const resolveRepoPathInWorkspace = (
  workspaceRoot: string,
  repoPath: RepoPath,
): Result<RepoPath, { readonly kind: "escapes_workspace" }> => {
  const rootReal = realpathSync(workspaceRoot);
  let current = rootReal;

  for (const segment of repoPath.split("/")) {
    current = resolve(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        current = realpathSync(current);
      }
    } catch {
      // target or intermediate does not exist yet (new file write)
    }
    if (!isInsideRoot(rootReal, current)) {
      return err({ kind: "escapes_workspace" });
    }
  }

  const relativePath = relative(rootReal, current);
  if (relativePath.startsWith("..")) {
    return err({ kind: "escapes_workspace" });
  }

  const reparsed = parseRepoPath(relativePath);
  if (!reparsed.ok) {
    return err({ kind: "escapes_workspace" });
  }

  return ok(reparsed.value);
};

/** Check whether a mutation to `rawPath` is permitted under `scope`. */
export const checkMutationAllowed = (
  scope: WriteScope,
  toolName: string,
  rawPath: string,
  workspaceRoot?: string,
): ScopeDenial | undefined => {
  if (!isMutationTool(toolName)) return undefined;

  const parsed = parseRepoPath(rawPath);
  if (!parsed.ok) {
    return {
      kind: "scope_denied",
      toolName,
      path: rawPath,
      reason: `Invalid repo path: ${rawPath}`,
    };
  }

  const denyOutsideScope = (path: RepoPath): ScopeDenial => ({
    kind: "scope_denied",
    toolName,
    path,
    reason: `Write to "${path}" is outside the granted scope`,
  });

  if (!pathWithinScope(scope, parsed.value)) {
    return denyOutsideScope(parsed.value);
  }

  if (workspaceRoot !== undefined) {
    const resolved = resolveRepoPathInWorkspace(workspaceRoot, parsed.value);
    if (!resolved.ok) {
      return {
        kind: "scope_denied",
        toolName,
        path: parsed.value,
        reason: `Write to "${parsed.value}" escapes the workspace via symlink or traversal`,
      };
    }
    if (!pathWithinScope(scope, resolved.value)) {
      return {
        kind: "scope_denied",
        toolName,
        path: parsed.value,
        reason: `Write to "${parsed.value}" resolves outside the granted scope`,
      };
    }
  }

  return undefined;
};

export type GrantDenial = ScopeDenial | OracleDenial;

/** Single grant decision — scope + optional oracle freeze (D6/D7). */
export const evaluateToolCallUnderGrant = (
  scope: WriteScope,
  toolName: string,
  args: unknown,
  workspaceRoot?: string,
  oracleFreeze?: OracleFreezeRecord,
): GrantDenial | undefined => {
  if (oracleFreeze !== undefined && isMutationTool(toolName)) {
    const rawPath = extractWritePath(toolName, args);
    if (rawPath !== undefined) {
      const oracleDenial = checkOracleMutationAllowed(oracleFreeze, toolName, rawPath);
      if (oracleDenial !== undefined) return oracleDenial;
    }
  }
  return evaluateToolCallUnderScope(scope, toolName, args, workspaceRoot);
};

/** Single scope decision for a tool call under a grant — fail closed on unknown tools. */
export const evaluateToolCallUnderScope = (
  scope: WriteScope,
  toolName: string,
  args: unknown,
  workspaceRoot?: string,
): ScopeDenial | undefined => {
  if (isReadOnlyTool(toolName)) return undefined;

  if (isMutationTool(toolName)) {
    const rawPath = extractWritePath(toolName, args);
    if (rawPath === undefined) {
      return {
        kind: "scope_denied",
        toolName,
        path: "unknown",
        reason: `Mutation tool "${toolName}" requires a string path argument`,
      };
    }
    return checkMutationAllowed(scope, toolName, rawPath, workspaceRoot);
  }

  return {
    kind: "scope_denied",
    toolName,
    path: "unknown",
    reason: `Tool "${toolName}" is not permitted under a write scope grant`,
  };
};

const toBlockResult = (denial: GrantDenial): BeforeToolCallResult & ToolCallEventResult => ({
  block: true,
  reason: denial.reason,
});

/** pi-agent-core hook: block mutation tools outside grant or frozen oracle. */
export const createBeforeToolCallGuard =
  (scope: WriteScope, workspaceRoot?: string, oracleFreeze?: OracleFreezeRecord) =>
  async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const denial = evaluateToolCallUnderGrant(
      scope,
      context.toolCall.name,
      context.args,
      workspaceRoot,
      oracleFreeze,
    );
    return denial ? toBlockResult(denial) : undefined;
  };

/** Pi extension factory (S2/W7): enforce scope and oracle freeze on write/edit. */
export const createPathProtectionExtension =
  (scope: WriteScope, workspaceRoot?: string, oracleFreeze?: OracleFreezeRecord) =>
  (pi: {
    on: (
      event: "tool_call",
      handler: (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>,
    ) => void;
  }): void => {
    pi.on("tool_call", async (event) => {
      const denial = evaluateToolCallUnderGrant(
        scope,
        event.toolName,
        event.input,
        workspaceRoot,
        oracleFreeze,
      );
      return denial ? toBlockResult(denial) : undefined;
    });
  };
