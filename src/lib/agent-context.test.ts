import { describe, expect, test } from "bun:test";
import {
  assembleAgentContext,
  assembleSystemPrompt,
  roleDoctrine,
  SPINE_SUBAGENT_PREAMBLE,
} from "./agent-context";
import type { Skill } from "./skills";

/**
 * Phase 4 S3 — byte-stable prefix per agent type (D26).
 *
 * The assembled prefix is a pure function of (agentKind, skill bodies/versions);
 * it never carries lineage ids, scope, nonces, or timestamps (those travel
 * out-of-band, D6/D26), so two different tasks for the same agent type produce a
 * byte-identical prefix and prompt-cache hits are not silently destroyed.
 */
const skill: Skill = {
  name: "implementation",
  version: "1",
  body: "# Implementation skill\n\nApply the smallest change within scope.",
  libReferences: ["src/lib/gate-runner.ts"],
};

describe("P4/S3 — stable agent prefix (D26)", () => {
  test("two different tasks for the same agent type yield a byte-identical prefix", () => {
    // The assembler deliberately takes no task — task data is the variable tail.
    const a = assembleSystemPrompt("implementer", [skill]);
    const b = assembleSystemPrompt("implementer", [skill]);
    expect(a).toBe(b);
    expect(a.startsWith(SPINE_SUBAGENT_PREAMBLE)).toBe(true);
    expect(a).toContain(roleDoctrine("implementer"));
  });

  test("volatile per-invocation data never appears in the prefix (out-of-band, D6/D26)", () => {
    const prefix = assembleSystemPrompt("implementer", [skill]);
    const volatile = [
      "lineage-abc123",
      "inv-2026-06-17",
      "src/secret/scope-grant",
      String(Date.now()),
    ];
    for (const token of volatile) {
      expect(prefix.includes(token)).toBe(false);
    }
  });

  test("different agent types produce different stable prefixes", () => {
    expect(assembleSystemPrompt("implementer", [skill])).not.toBe(
      assembleSystemPrompt("test_author", [skill]),
    );
  });

  test("W3: assembleAgentContext keeps a stable prefix while the task varies in the tail", () => {
    const a = assembleAgentContext("implementer", [skill], "task one");
    const b = assembleAgentContext("implementer", [skill], "task two");
    // The cache breakpoint is the prefix/tail boundary: prefix stable, tail varies.
    expect(a.prefix).toBe(b.prefix);
    expect(a.tail).toBe("task one");
    expect(b.tail).toBe("task two");
    expect(a.prefix).toContain(skill.body);
  });

  test("spine subagents carry an isolation preamble; stub does not", () => {
    const implementer = assembleSystemPrompt("implementer", [skill]);
    expect(implementer).toContain("not as an external task author");
    expect(implementer).toContain("Do not route work through Snaffle");
    expect(assembleSystemPrompt("stub", [skill])).not.toContain(
      "Do not route work through Snaffle",
    );
  });
});
