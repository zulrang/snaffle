import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  registerFauxProvider,
  streamSimple,
  Type,
} from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import type { AgentOutcome, AgentResult, FileEdit } from "../domain/agent";
import type { InvocationId } from "../domain/ids";
import { parseRepoPath, type WriteScope } from "../domain/scope";
import { err, ok, type Result } from "../domain/shared";
import { createBeforeToolCallGuard } from "../lib/scope-guard";

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

export interface StubInvocationOptions {
  readonly scope?: WriteScope;
  readonly onScopeDenial?: (denial: { reason: string; path: string }) => void;
}

export interface StubInvocationError {
  readonly kind: "invalid_target_path" | "agent_error";
  readonly detail: string;
}

const PI_AGENT_CORE_VERSION = "0.74.0";
const PI_AI_VERSION = "0.74.0";

const createScopedWriteTool = (edits: FileEdit[]): AgentTool<typeof writeSchema> => ({
  name: "scoped_write",
  label: "Scoped Write",
  description: "Write content to a repo-relative path within the granted scope.",
  parameters: writeSchema,
  executionMode: "sequential",
  execute: async (_toolCallId, params: WriteParams) => {
    const parsed = parseRepoPath(params.path);
    if (!parsed.ok) throw new Error(parsed.error.kind);

    edits.push({ path: parsed.value, operation: "modify" });
    return {
      content: [{ type: "text", text: `Wrote ${params.path}` }],
      details: { path: params.path, bytes: params.content.length },
      terminate: true,
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

/**
 * S1 — drive a stub Pi agent headlessly via pi-agent-core with a pinned faux model.
 *
 * No interactive session, no network: the faux provider returns a scripted tool call,
 * the agent executes it, and the spine receives a validated structured result.
 */
export const invokeStubAgent = async (
  task: StubInvocationTask,
  options: StubInvocationOptions = {},
): Promise<Result<StubInvocationResult, StubInvocationError>> => {
  const target = parseRepoPath(task.targetPath);
  if (!target.ok) {
    return err({ kind: "invalid_target_path", detail: task.targetPath });
  }

  const faux = registerFauxProvider({
    provider: "orchestrator-stub",
    models: [
      {
        id: STUB_MODEL_ID,
        name: "Orchestrator Stub Agent",
        reasoning: false,
      },
    ],
  });

  try {
    const model = faux.getModel(STUB_MODEL_ID) as Model<string>;
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("scoped_write", { path: task.targetPath, content: task.content }),
      ]),
    ]);

    const edits: FileEdit[] = [];
    const scopeDenials: Array<{ reason: string; path: string }> = [];
    const scopeGuard = options.scope ? createBeforeToolCallGuard(options.scope) : undefined;

    const agent = new Agent({
      initialState: {
        systemPrompt: "You are a deterministic stub agent for the orchestrator spine.",
        model,
        thinkingLevel: "off",
        tools: [createScopedWriteTool(edits)],
      },
      streamFn: streamSimple,
      toolExecution: "sequential",
      ...(scopeGuard
        ? {
            beforeToolCall: async (context) => {
              const result = await scopeGuard(context);
              if (result?.block) {
                const denial = {
                  reason: result.reason ?? "blocked",
                  path: task.targetPath,
                };
                scopeDenials.push(denial);
                options.onScopeDenial?.(denial);
              }
              return result;
            },
          }
        : {}),
    });

    let agentError: string | undefined;
    agent.subscribe((event: AgentEvent) => {
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
          : `Stub edit applied to ${task.targetPath}`;

    if (status === "failed") {
      return err({ kind: "agent_error", detail: summary });
    }

    return ok({
      status,
      edits,
      metadata: {
        provider: model.provider,
        modelId: model.id,
        modelVersion: STUB_MODEL_VERSION,
        sdkVersions: {
          piAgentCore: PI_AGENT_CORE_VERSION,
          piAi: PI_AI_VERSION,
        },
      },
      invocationId: task.invocationId,
      summary,
    });
  } finally {
    faux.unregister();
  }
};

/** Convert a stub invocation result into the domain evidence type (D19). */
export const stubResultToAgentResult = (result: StubInvocationResult): AgentResult =>
  toAgentResult(result);
