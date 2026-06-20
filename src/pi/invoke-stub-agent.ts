import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
  registerFauxProvider,
  streamSimple,
  Type,
  type Usage,
} from "@earendil-works/pi-ai";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { AgentOutcome, AgentResult, FileEdit } from "../domain/agent";
import type { InvocationId } from "../domain/ids";
import { parseRepoPath, type RepoPath, type WriteScope } from "../domain/scope";
import { err, ok, type Result } from "../domain/shared";
import type { OracleFreezeRecord } from "../lib/oracle-freeze";
import type { ModelRef } from "../lib/orchestrator-config";
import { checkMutationAllowed, createBeforeToolCallGuard } from "../lib/scope-guard";
import { assertIsolatedSystemPrompt, type ExplicitSkillRef } from "./isolated-invocation";
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
  /** Skills explicitly composed by the spine for this invocation (never from Pi env discovery). */
  readonly explicitSkills?: readonly ExplicitSkillRef[];
}

export interface CapturedWrite {
  readonly path: RepoPath;
  readonly content: string;
}

/** Structured result from a headless stub invocation (S1). Maps to domain `AgentResult`. */
export interface StubInvocationResult {
  readonly status: AgentOutcome;
  readonly edits: readonly FileEdit[];
  readonly writes: readonly CapturedWrite[];
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
   * Config-resolved tier model (D18, W7). The faux provider still drives execution;
   * when set, the recorded metadata reflects this provider-neutral ref instead of the
   * pinned faux stub model, so a config swap changes provenance without code change.
   */
  readonly modelRef?: ModelRef;
  /**
   * Assembled stable-prefix system prompt (D26, Phase 4). When set, it replaces the
   * default stub system prompt — this is how composed role/skill doctrine reaches the
   * agent. Must carry no volatile data (scope/ids travel out-of-band, D6/D26).
   */
  readonly systemPrompt?: string;
  /**
   * Frozen oracle handed to the implementer read-only (D7). When set, a write to any
   * frozen-test path is blocked by the same guard that enforces scope, so the gradee
   * cannot edit its grader.
   */
  readonly oracleFreeze?: OracleFreezeRecord;
  /** Skill set composed by the spine; recorded in metadata and asserted isolated. */
  readonly explicitSkills?: readonly ExplicitSkillRef[];
  /**
   * Reuse an existing faux registration so prompt-cache state survives across
   * invocations (tests and spine session reuse). When omitted, a registration is
   * created for this call and unregistered in `finally`.
   */
  readonly fauxRegistration?: FauxProviderRegistration;
  /** Execute against the configured live provider instead of the deterministic faux queue. */
  readonly invocationMode?: "faux" | "live";
  /** Bounds prompt + tool execution; defaults on for live calls and off for faux calls. */
  readonly invocationTimeoutMs?: number;
}

export interface StubInvocationError {
  readonly kind: "invalid_target_path" | "agent_error";
  readonly detail: string;
}

const PI_AGENT_CORE_VERSION = "0.74.0";
const PI_AI_VERSION = "0.74.0";
const DEFAULT_LIVE_INVOCATION_TIMEOUT_MS = 90_000;

export const resolveInvocationTimeoutMs = (
  invocationMode: "faux" | "live",
  env: Record<string, string | undefined> & {
    readonly SNAFFLE_AGENT_TIMEOUT_MS?: string;
  } = process.env,
): number | undefined => {
  const raw = env.SNAFFLE_AGENT_TIMEOUT_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (parsed === 0) return undefined;
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return invocationMode === "live" ? DEFAULT_LIVE_INVOCATION_TIMEOUT_MS : undefined;
};

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

const isKnownProvider = (provider: string): provider is KnownProvider =>
  (getProviders() as readonly string[]).includes(provider);

const resolveLiveModel = (
  modelRef: ModelRef | undefined,
): Result<Model<Api>, StubInvocationError> => {
  if (modelRef === undefined) {
    return err({ kind: "agent_error", detail: "live invocation requires a modelRef" });
  }
  if (!isKnownProvider(modelRef.provider)) {
    return err({ kind: "agent_error", detail: `unknown live provider: ${modelRef.provider}` });
  }
  const model = (getModels(modelRef.provider) as readonly Model<Api>[]).find(
    (candidate) => candidate.id === modelRef.model,
  );
  if (model === undefined) {
    return err({
      kind: "agent_error",
      detail: `unknown model for provider ${modelRef.provider}: ${modelRef.model}`,
    });
  }
  return ok(model);
};

const createLiveAuthStorage = (): AuthStorage => {
  const { SNAFFLE_PI_AUTH_JSON } = process.env;
  return AuthStorage.create(SNAFFLE_PI_AUTH_JSON);
};

interface RunnableAgent {
  prompt(prompt: string): Promise<unknown>;
  waitForIdle(): Promise<unknown>;
  abort(): void;
}

const runPromptToIdle = async (
  agent: RunnableAgent,
  prompt: string,
  timeoutMs: number | undefined,
): Promise<Result<void, StubInvocationError>> => {
  const run = (async () => {
    await agent.prompt(prompt);
    await agent.waitForIdle();
  })();

  const completed = run
    .then(() => ok(undefined))
    .catch((error) =>
      err({
        kind: "agent_error" as const,
        detail: error instanceof Error ? error.message : String(error),
      }),
    );

  if (timeoutMs === undefined) return completed;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Result<void, StubInvocationError>>((resolve) => {
    timeout = setTimeout(() => {
      agent.abort();
      resolve(
        err({
          kind: "agent_error",
          detail: `agent invocation timed out after ${timeoutMs}ms`,
        }),
      );
    }, timeoutMs);
  });

  const result = await Promise.race([completed, timedOut]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
};

const createScopedWriteTool = (
  edits: FileEdit[],
  capturedWrites: CapturedWrite[],
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
    capturedWrites.push({ path: parsed.value, content: params.content });
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
  const invocationMode = options.invocationMode ?? "faux";
  if (invocationMode === "faux" && writes.length === 0) {
    return err({ kind: "invalid_target_path", detail: "no writes requested" });
  }

  const faux =
    invocationMode === "faux"
      ? (options.fauxRegistration ?? createDefaultFauxRegistration())
      : undefined;
  const ownsFaux = invocationMode === "faux" && options.fauxRegistration === undefined;

  try {
    let model: Model<Api>;
    if (invocationMode === "live") {
      const resolved = resolveLiveModel(options.modelRef);
      if (!resolved.ok) return resolved;
      model = resolved.value;
    } else {
      const registration = faux as FauxProviderRegistration;
      model = registration.getModel(STUB_MODEL_ID) as Model<Api>;
      registration.setResponses(
        writes.map((write) =>
          fauxAssistantMessage([
            fauxToolCall("scoped_write", { path: write.path, content: write.content }),
          ]),
        ),
      );
    }

    const edits: FileEdit[] = [];
    const capturedWrites: CapturedWrite[] = [];
    const scopeDenials: ScopeDenialEvent[] = [];
    const authStorage = invocationMode === "live" ? createLiveAuthStorage() : undefined;
    const scopeGuard = options.scope
      ? createBeforeToolCallGuard(options.scope, options.workspaceRoot, options.oracleFreeze)
      : undefined;
    const streamFn = options.promptCache ? createCachedStreamFn(options.promptCache) : streamSimple;
    const invocationTimeoutMs =
      options.invocationTimeoutMs ?? resolveInvocationTimeoutMs(invocationMode);
    const systemPrompt =
      options.systemPrompt ?? "You are a deterministic stub agent for the orchestrator spine.";
    assertIsolatedSystemPrompt(systemPrompt);

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "off",
        tools: [
          createScopedWriteTool(
            edits,
            capturedWrites,
            writes.length,
            options.scope,
            options.workspaceRoot,
            options.onWriteAllowed,
          ),
        ],
      },
      streamFn,
      toolExecution: "sequential",
      ...(authStorage === undefined
        ? {}
        : { getApiKey: (provider: string) => authStorage.getApiKey(provider) }),
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

    const completed = await runPromptToIdle(agent, task.prompt, invocationTimeoutMs);
    if (!completed.ok) return completed;

    const status: AgentOutcome =
      scopeDenials.length > 0
        ? "refused"
        : agentError || edits.length === 0
          ? "failed"
          : "succeeded";

    const summary =
      status === "refused"
        ? (scopeDenials[0]?.reason ?? "Write refused by scope guard")
        : status === "failed"
          ? (agentError ?? "Agent produced no edits")
          : writes.length === 1
            ? `Stub edit applied to ${writes[0]?.path ?? "unknown"}`
            : `Stub edits applied (${edits.length}/${writes.length} writes)`;

    const evidenceEdits = status === "succeeded" ? edits : [];
    const evidenceWrites = status === "succeeded" ? capturedWrites : [];

    return ok({
      status,
      edits: evidenceEdits,
      writes: evidenceWrites,
      metadata: {
        provider: options.modelRef?.provider ?? model.provider,
        modelId: options.modelRef?.model ?? model.id,
        modelVersion: options.modelRef?.version ?? STUB_MODEL_VERSION,
        sdkVersions: {
          piAgentCore: PI_AGENT_CORE_VERSION,
          piAi: PI_AI_VERSION,
        },
        ...(usage ? { usage } : {}),
        ...(options.promptCache ? { promptCache: options.promptCache } : {}),
        ...(options.explicitSkills === undefined ? {} : { explicitSkills: options.explicitSkills }),
      },
      invocationId: task.invocationId,
      summary,
    });
  } finally {
    if (ownsFaux) {
      faux?.unregister();
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
