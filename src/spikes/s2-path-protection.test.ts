import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  streamSimple,
  Type,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { createPathProtectionExtension } from "../extensions/path-protection";
import { createBeforeToolCallGuard } from "../lib/scope-guard";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const scope = must(makeWriteScope([must(parseRepoPath("src/domain"))]));

type ToolCallHandler = (
  event: ToolCallEvent,
) => Promise<{ block?: boolean; reason?: string } | undefined>;

const installExtensionHandler = (workspaceRoot?: string): ToolCallHandler => {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on: (event: string, h: ToolCallHandler) => {
      if (event === "tool_call") handler = h;
    },
  } as ExtensionAPI;

  createPathProtectionExtension(scope, workspaceRoot)(pi);
  if (!handler) throw new Error("path protection extension did not register a handler");
  return handler;
};

const writeEvent = (path: string): ToolCallEvent => ({
  type: "tool_call",
  toolCallId: "tc-1",
  toolName: "write",
  input: { path, content: "x" },
});

describe("S2 — Pi extension path protection", () => {
  test("blocks a write outside the granted scope and returns an observable reason", async () => {
    const handler = installExtensionHandler();

    const blocked = await handler(writeEvent("src/secrets/key.ts"));
    expect(blocked).toEqual({
      block: true,
      reason: 'Write to "src/secrets/key.ts" is outside the granted scope',
    });
  });

  test("allows an in-scope write", async () => {
    const handler = installExtensionHandler();

    const allowed = await handler(writeEvent("src/domain/gate.ts"));
    expect(allowed).toBeUndefined();
  });

  test("blocks edit mutations the same way as write", async () => {
    const handler = installExtensionHandler();

    const blocked = await handler({
      type: "tool_call",
      toolCallId: "tc-2",
      toolName: "edit",
      input: { path: "config/production.toml", edits: [{ oldText: "a", newText: "b" }] },
    });

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("outside the granted scope");
  });

  test("blocks scoped_write outside scope", async () => {
    const handler = installExtensionHandler();

    const blocked = await handler({
      type: "tool_call",
      toolCallId: "tc-3",
      toolName: "scoped_write",
      input: { path: "src/secrets/key.ts", content: "x" },
    });

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("outside the granted scope");
  });
});

describe("S2 — path escape vectors (D6)", () => {
  const escapeVectors: readonly { readonly label: string; readonly path: string }[] = [
    { label: "absolute path", path: "/etc/passwd" },
    { label: "parent traversal", path: "src/domain/../../secrets/forbidden.ts" },
    {
      label: "redundant separators and dot segments",
      path: "src//domain/.././../secrets/forbidden.ts",
    },
    { label: "case variant", path: "SRC/SECRETS/forbidden.ts" },
  ];

  for (const vector of escapeVectors) {
    test(`extension blocks ${vector.label}`, async () => {
      const handler = installExtensionHandler();
      const blocked = await handler({
        type: "tool_call",
        toolCallId: `tc-${vector.label}`,
        toolName: "write",
        input: { path: vector.path, content: "x" },
      });
      expect(blocked?.block).toBe(true);
    });
  }
});

describe("S2 — symlink escape via extension (D6)", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("blocks a write through an in-scope symlink that resolves outside scope", async () => {
    workspace = mkdtempSync(join(tmpdir(), "orchestrator-s2-symlink-"));
    mkdirSync(join(workspace, "src/domain"), { recursive: true });
    mkdirSync(join(workspace, "src/secrets"), { recursive: true });
    symlinkSync(join(workspace, "src/secrets"), join(workspace, "src/domain/escape"));

    const handler = installExtensionHandler(workspace);
    const blocked = await handler({
      type: "tool_call",
      toolCallId: "tc-symlink",
      toolName: "write",
      input: { path: "src/domain/escape/pwned.ts", content: "x" },
    });

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("resolves outside the granted scope");
  });
});

describe("S2 — pi-agent-core beforeToolCall adapter (same lib/ guard)", () => {
  test("in-scope write succeeds; out-of-scope write is denied to the orchestrator", async () => {
    const writeSchema = Type.Object({
      path: Type.String(),
      content: Type.String(),
    });

    const faux = registerFauxProvider();
    try {
      const model = faux.getModel();
      const executedPaths: string[] = [];
      const blockedReasons: string[] = [];

      const writeTool: AgentTool<typeof writeSchema> = {
        name: "write",
        label: "Write",
        description: "Write a file",
        parameters: writeSchema,
        executionMode: "sequential",
        execute: async (_id, params) => {
          executedPaths.push(params.path);
          return {
            content: [{ type: "text", text: "ok" }],
            details: {},
            terminate: true,
          };
        },
      };

      const run = async (path: string): Promise<void> => {
        faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path, content: "x" })])]);

        const agent = new Agent({
          initialState: {
            systemPrompt: "test",
            model,
            thinkingLevel: "off",
            tools: [writeTool],
          },
          streamFn: streamSimple,
          toolExecution: "sequential",
          beforeToolCall: async (context) => {
            const result = await createBeforeToolCallGuard(scope)(context);
            if (result?.block && result.reason) blockedReasons.push(result.reason);
            return result;
          },
        });

        await agent.prompt(`write ${path}`);
        await agent.waitForIdle();
      };

      await run("src/domain/allowed.ts");
      await run("src/other/forbidden.ts");

      expect(executedPaths).toEqual(["src/domain/allowed.ts"]);
      expect(blockedReasons).toHaveLength(1);
      expect(blockedReasons[0]).toContain("outside the granted scope");
    } finally {
      faux.unregister();
    }
  });
});
