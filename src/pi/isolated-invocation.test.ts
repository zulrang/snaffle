import { describe, expect, test } from "bun:test";
import { assertIsolatedSystemPrompt, SPINE_AGENT_TOOL_NAMES } from "./isolated-invocation";

describe("Pi spine invocation isolation", () => {
  test("the spine exposes only scoped_write to subagents", () => {
    expect(SPINE_AGENT_TOOL_NAMES).toEqual(["scoped_write"]);
  });

  test("environment skill discovery markers are rejected in the system prompt", () => {
    expect(() => assertIsolatedSystemPrompt("ok prefix")).not.toThrow();
    expect(() => assertIsolatedSystemPrompt("<available_skills>")).toThrow(
      "environment skill marker",
    );
    expect(() => assertIsolatedSystemPrompt("see .pi/skills/snaffle")).toThrow(
      "environment skill marker",
    );
    expect(() => assertIsolatedSystemPrompt(".cursor/skills/snaffle")).toThrow(
      "environment skill marker",
    );
  });
});
