import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { parseRepoPath, pathWithinScope, type WriteScope } from "../domain/scope";

/**
 * Deterministic write-scope enforcement (D6, D12).
 *
 * The same rules run in three places: the orchestrator's pre-check over agent
 * results, pi-agent-core's `beforeToolCall`, and the Pi extension's
 * `tool_call` handler. One implementation, no drift.
 */

export const MUTATION_TOOL_NAMES = ["write", "edit", "scoped_write"] as const;
export type MutationToolName = (typeof MUTATION_TOOL_NAMES)[number];

export interface ScopeDenial {
  readonly kind: "scope_denied";
  readonly toolName: string;
  readonly path: string;
  readonly reason: string;
}

const isMutationTool = (toolName: string): toolName is MutationToolName =>
  (MUTATION_TOOL_NAMES as readonly string[]).includes(toolName);

/** Extract the target path from a mutation tool's validated arguments. */
export const extractWritePath = (toolName: string, args: unknown): string | undefined => {
  if (!isMutationTool(toolName)) return undefined;
  if (typeof args !== "object" || args === null || !("path" in args)) return undefined;
  const path = (args as { path: unknown }).path;
  return typeof path === "string" ? path : undefined;
};

/** Check whether a mutation to `rawPath` is permitted under `scope`. */
export const checkMutationAllowed = (
  scope: WriteScope,
  toolName: string,
  rawPath: string,
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

  if (!pathWithinScope(scope, parsed.value)) {
    return {
      kind: "scope_denied",
      toolName,
      path: parsed.value,
      reason: `Write to "${parsed.value}" is outside the granted scope`,
    };
  }

  return undefined;
};

const toBlockResult = (denial: ScopeDenial): BeforeToolCallResult & ToolCallEventResult => ({
  block: true,
  reason: denial.reason,
});

/** pi-agent-core hook: block mutation tools outside the granted scope. */
export const createBeforeToolCallGuard =
  (scope: WriteScope) =>
  async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const rawPath = extractWritePath(context.toolCall.name, context.args);
    if (rawPath === undefined) return undefined;

    const denial = checkMutationAllowed(scope, context.toolCall.name, rawPath);
    return denial ? toBlockResult(denial) : undefined;
  };

/** Pi extension factory (S2): enforce spine-supplied allowed paths on write/edit. */
export const createPathProtectionExtension =
  (scope: WriteScope) =>
  (pi: {
    on: (
      event: "tool_call",
      handler: (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>,
    ) => void;
  }): void => {
    pi.on("tool_call", async (event) => {
      const rawPath =
        event.toolName === "write" || event.toolName === "edit"
          ? event.input.path
          : extractWritePath(event.toolName, event.input);

      if (typeof rawPath !== "string") return undefined;

      const denial = checkMutationAllowed(scope, event.toolName, rawPath);
      return denial ? toBlockResult(denial) : undefined;
    });
  };
