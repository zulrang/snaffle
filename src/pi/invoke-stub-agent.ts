import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  registerFauxProvider,
  streamSimple,
  Type,
  type Usage,
} from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import type { AgentOutcome, AgentResult, FileEdit } from "../domain/agent";
import type { InvocationId } from "../domain/ids";
import { parseRepoPath, type RepoPath, type WriteScope } from "../domain/scope";
import { err, ok, type Result } from "../domain/shared";
import { checkMutationAllowed, createBeforeToolCallGuard } from "../lib/scope-guard";
import { createCachedStreamFn, type PromptCacheHint } from "./prompt-cache";

/** Pinned stub model used by S1 — deterministic, no network, no interactive session. */
export const STUB_MODEL_ID = "orchestrator-stub-v1";
export const STUB_MODEL_VERSION = "0.74.0";

const writeSchema = Type.Object({
  path: Type.String({ description: "Repo-relative path to write" }),
  content: Type.String({ description: "File content" }),
});

type WriteParams = Static<typeof writeSchema>;

export interface StubInvocationMetadata {
  readonly provider: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly sdkVersions: {
    readonly piAgentCore: string;
    readonly piAi: string;
  };
  readonly usage?: Usage;
  readonly promptCache?: PromptCacheHint;
}

/** Structured result from a headless stub invocation (S1). Maps to domain `AgentResult`. */
export interface StubInvocationResult {
  readonly status: AgentOutcome;
  readonly edits: readonly FileEdit[];
  readonly metadata: StubInvocationMetadata;
  readonly invocationId: InvocationId;
  readonly summary: string;
}

export interface StubInvocationTask {
  readonly invocationId: InvocationId;
  readonly prompt: string;
  readonly targetPath: string;
  readonly content: string;
}

export interface StubSequenceWrite {
  readonly path: string;
  readonly content: string;
}

export interface StubSequenceTask {
  readonly invocationId: InvocationId;
  readonly prompt: string;
  readonly writes: readonly StubSequenceWrite[];
}

export interface ScopeDenialEvent {
  readonly reason: string;
  readonly path: string;
}

export interface StubInvocationOptions {
  readonly scope?: WriteScope;
  /** When set, symlink hops are resolved before scope checks (D6 filesystem vectors). */
  readonly workspaceRoot?: string;
  readonly onScopeDenial?: (denial: ScopeDenialEvent, toolName: string) => void;
  readonly onWriteAllowed?: (path: RepoPath, toolName: string) => void;
  /** pi-ai prompt cache hint forwarded through streamSimple / agent sessionId. */
  readonly promptCache?: PromptCacheHint;
  /**
   * Reuse an existing faux registration so prompt-cache state survives across
   * invocations (tests and spine session reuse). When omitted, a registration is
   * created for this call and unregistered in `finally`.
   */
  readonly fauxRegistration?: FauxProviderRegistration;
}

export interface StubInvocationError {
  readonly kind: "invalid_target_path" | "agent_error";
  readonly detail: string;
}

const PI_AGENT_CORE_VERSION = "0.74.0";
const PI_AI_VERSION = "0.74.0";

const createDefaultFauxRegistration = (): FauxProviderRegistration =>
  registerFauxProvider({
    provider: "orchestrator-stub",
    models: [
      {
        id: STUB_MODEL_ID,
        name: "Orchestrator Stub Agent",
        reasoning: false,
      },
    ],
  });

/** Shared faux environment for repeated invocations (prompt-cache tests, spine sessions). */
export const createStubFauxEnvironment = (): {
  readonly registration: FauxProviderRegistration;
  readonly dispose: () => void;
} => {
  const registration = createDefaultFauxRegistration();
  return {
    registration,
    dispose: () => registration.unregister(),
  };
};

const createScopedWriteTool = (
  edits: FileEdit[],
  totalWrites: number,
  scope: WriteScope | undefined,
  workspaceRoot: string | undefined,
  onWriteAllowed?: (path: RepoPath, toolName: string) => void,
): AgentTool<typeof writeSchema> => ({
  name: "scoped_write",
  label: "Scoped Write",
  description: "Write content to a repo-relative path within the granted scope.",
  parameters: writeSchema,
  executionMode: "sequential",
  execute: async (_toolCallId, params: WriteParams) => {
    const parsed = parseRepoPath(params.path);
    if (!parsed.ok) throw new Error(parsed.error.kind);

    if (scope) {
      const denial = checkMutationAllowed(scope, "scoped_write", params.path, workspaceRoot);
      if (denial) throw new Error(denial.reason);
    }

    edits.push({ path: parsed.value, operation: "modify" });
    onWriteAllowed?.(parsed.value, "scoped_write");
    return {
      content: [{ type: "text", text: `Wrote ${params.path}` }],
      details: { path: params.path, bytes: params.content.length },
      ...(totalWrites === 1 ? { terminate: true as const } : {}),
    };
  },
});

const toAgentResult = (result: StubInvocationResult): AgentResult => ({
  invocationId: result.invocationId,
  agentKind: "stub",
  outcome: result.status,
  edits: result.edits,
  summary: result.summary,
});

const runStubAgent = async (
  task: { readonly invocationId: InvocationId; readonly prompt: string },
  writes: readonly StubSequenceWrite[],
  options: StubInvocationOptions = {},
): Promise<Result<StubInvocationResult, StubInvocationError>> => {
  if (writes.length === 0) {
    return err({ kind: "invalid_target_path", detail: "no writes requested" });
  }

  const faux = options.fauxRegistration ?? createDefaultFauxRegistration();
  const ownsFaux = options.fauxRegistration === undefined;

  try {
    const model = faux.getModel(STUB_MODEL_ID) as Model<string>;
    faux.setResponses(
      writes.map((write) =>
        fauxAssistantMessage([
          fauxToolCall("scoped_write", { path: write.path, content: write.content }),
        ]),
      ),
    );

    const edits: FileEdit[] = [];
    const scopeDenials: ScopeDenialEvent[] = [];
    const scopeGuard = options.scope
      ? createBeforeToolCallGuard(options.scope, options.workspaceRoot)
      : undefined;
    const streamFn = options.promptCache ? createCachedStreamFn(options.promptCache) : streamSimple;

    const agent = new Agent({
      initialState: {
        systemPrompt: "You are a deterministic stub agent for the orchestrator spine.",
        model,
        thinkingLevel: "off",
        tools: [
          createScopedWriteTool(
            edits,
            writes.length,
            options.scope,
            options.workspaceRoot,
            options.onWriteAllowed,
          ),
        ],
      },
      streamFn,
      toolExecution: "sequential",
      ...(options.promptCache ? { sessionId: options.promptCache.sessionId } : {}),
      ...(scopeGuard
        ? {
            beforeToolCall: async (context) => {
              const result = await scopeGuard(context);
              if (result?.block) {
                const rawPath =
                  typeof context.args === "object" &&
                  context.args !== null &&
                  "path" in context.args &&
                  typeof context.args.path === "string"
                    ? context.args.path
                    : "unknown";
                const denial = {
                  reason: result.reason ?? "blocked",
                  path: rawPath,
                };
                scopeDenials.push(denial);
                options.onScopeDenial?.(denial, context.toolCall.name);
              }
              return result;
            },
          }
        : {}),
    });

    let agentError: string | undefined;
    let usage: Usage | undefined;
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        usage = event.message.usage;
      }
      if (event.type === "agent_end" && agent.state.errorMessage) {
        agentError = agent.state.errorMessage;
      }
    });

    await agent.prompt(task.prompt);
    await agent.waitForIdle();

    const status: AgentOutcome =
      scopeDenials.length > 0 ? "refused" : agentError ? "failed" : "succeeded";

    const summary =
      status === "refused"
        ? (scopeDenials[0]?.reason ?? "Write refused by scope guard")
        : status === "failed"
          ? (agentError ?? "Agent run failed")
          : writes.length === 1
            ? `Stub edit applied to ${writes[0]?.path ?? "unknown"}`
            : `Stub edits applied (${edits.length}/${writes.length} writes)`;

    const evidenceEdits = status === "succeeded" ? edits : [];

    return ok({
      status,
      edits: evidenceEdits,
      metadata: {
        provider: model.provider,
        modelId: model.id,
        modelVersion: STUB_MODEL_VERSION,
        sdkVersions: {
          piAgentCore: PI_AGENT_CORE_VERSION,
          piAi: PI_AI_VERSION,
        },
        ...(usage ? { usage } : {}),
        ...(options.promptCache ? { promptCache: options.promptCache } : {}),
      },
      invocationId: task.invocationId,
      summary,
    });
  } finally {
    if (ownsFaux) {
      faux.unregister();
    }
  }
};

/**
 * S1 — drive a stub Pi agent headlessly via pi-agent-core with a pinned faux model.
 *
 * No interactive session, no network: the faux provider returns a scripted tool call,
 * the agent executes it, and the spine receives a validated structured result.
 */
export const invokeStubAgent = async (
  task: StubInvocationTask,
  options: StubInvocationOptions = {},
): Promise<Result<StubInvocationResult, StubInvocationError>> =>
  runStubAgent(task, [{ path: task.targetPath, content: task.content }], options);

/** Run multiple scripted writes in one agent session (W3). */
export const invokeStubAgentSequence = async (
  task: StubSequenceTask,
  options: StubInvocationOptions = {},
): Promise<Result<StubInvocationResult, StubInvocationError>> =>
  runStubAgent(task, task.writes, options);

/** Convert a stub invocation result into the domain evidence type (D19). */
export const stubResultToAgentResult = (result: StubInvocationResult): AgentResult =>
  toAgentResult(result);
