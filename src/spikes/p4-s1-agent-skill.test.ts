import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { InvocationId } from "../domain/ids";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { assembleSystemPrompt, roleDoctrine, SPINE_SUBAGENT_PREAMBLE } from "../lib/agent-context";
import { loadSkill } from "../lib/skills";
import { validateAgentResult } from "../lib/validate-agent-result";
import { invokeStubAgentSequence, stubResultToAgentResult } from "../pi/invoke-stub-agent";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");

/**
 * Phase 4 S1 — agent⊕skill composition + invocation contract (D2, D3).
 *
 * Proves: a flat skill loads and references lib/ (never reimplements it, D12);
 * the assembler composes role + skill doctrine into a stable system prompt; the
 * faux-backed agent invoked with that prompt emits a scoped edit; the result
 * validates to the existing AgentResult shape (D19).
 */
describe("P4/S1 — composed implementer over a real skill (faux SDK)", () => {
  test("the implementation skill loads and references lib/ rather than reimplementing it (D12)", () => {
    const skill = must(loadSkill("implementation", repoRoot));
    expect(skill.version).toBe("2");
    expect(skill.libReferences).toContain("src/lib/gate-runner.ts");
    expect(skill.libReferences).toContain("src/lib/scope-guard.ts");
    // loadSkill returns ok only when the body carries no TS export (the D12 guard).
    expect(skill.libReferences.length).toBeGreaterThan(0);
  });

  test("the assembler composes role + skill doctrine into the system prompt", () => {
    const skill = must(loadSkill("implementation", repoRoot));
    const prompt = assembleSystemPrompt("implementer", [skill]);
    expect(prompt.startsWith(SPINE_SUBAGENT_PREAMBLE)).toBe(true);
    expect(prompt).toContain(roleDoctrine("implementer"));
    expect(prompt).toContain(skill.body);
  });

  test("the composed agent emits a scoped edit and the result validates", async () => {
    const skill = must(loadSkill("implementation", repoRoot));
    const systemPrompt = assembleSystemPrompt("implementer", [skill]);
    const scope = must(makeWriteScope([must(parseRepoPath("src/lib"))]));
    const invocationId = must(InvocationId("inv-p4-s1"));

    const result = must(
      await invokeStubAgentSequence(
        {
          invocationId,
          prompt: "Apply a trivial in-scope marker file.",
          writes: [{ path: "src/lib/p4-s1-marker.ts", content: "// p4 s1\n" }],
        },
        { scope, systemPrompt },
      ),
    );

    expect(result.status).toBe("succeeded");
    expect(result.edits).toHaveLength(1);
    expect(String(result.edits[0]?.path)).toBe("src/lib/p4-s1-marker.ts");

    const validated = must(validateAgentResult(stubResultToAgentResult(result), invocationId));
    expect(validated.outcome).toBe("succeeded");
    expect(String(validated.edits[0]?.path)).toBe("src/lib/p4-s1-marker.ts");
  });
});
