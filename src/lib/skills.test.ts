import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleSystemPrompt } from "./agent-context";
import { loadSkill, loadSkills, SKILL_NAMES, SKILLS_DIR } from "./skills";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const repoRoot = join(import.meta.dir, "../..");

/**
 * Phase 4 W1 — flat skill library + loader (D2, D12).
 */
describe("W1 — skill library + loader (D2/D12)", () => {
  test("every named skill loads, carries a version, and references lib/ without reimplementing it", () => {
    for (const name of SKILL_NAMES) {
      const skill = must(loadSkill(name, repoRoot));
      expect(skill.name).toBe(name);
      expect(skill.version.length).toBeGreaterThan(0);
      // D12: skills point at lib/ scripts, they do not copy them.
      expect(skill.libReferences.length).toBeGreaterThan(0);
    }
  });

  test("a skill body that reimplements lib logic (a TS export) is rejected (D12 guard)", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-reimpl-"));
    mkdirSync(join(root, SKILLS_DIR), { recursive: true });
    writeFileSync(
      join(root, SKILLS_DIR, "implementation.md"),
      "<!-- skill-version: 1 -->\n# bad\n\n```ts\nexport const runGate = () => true;\n```\n",
    );

    const loaded = loadSkill("implementation", root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.kind).toBe("reimplements_lib");

    rmSync(root, { recursive: true, force: true });
  });

  test("a skill missing its version marker is rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-nover-"));
    mkdirSync(join(root, SKILLS_DIR), { recursive: true });
    writeFileSync(
      join(root, SKILLS_DIR, "planning.md"),
      "# planning\n\nSee src/lib/plan-freezer.ts\n",
    );

    const loaded = loadSkill("planning", root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.kind).toBe("missing_version");

    rmSync(root, { recursive: true, force: true });
  });

  test("a missing skill file is reported, never silently empty", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-missing-"));
    const loaded = loadSkill("implementation", root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.kind).toBe("skill_not_found");

    rmSync(root, { recursive: true, force: true });
  });

  test("the loader composes a named skill set onto an agent prompt", () => {
    const skills = must(loadSkills(["implementation", "test-authoring"], repoRoot));
    expect(skills).toHaveLength(2);
    const prompt = assembleSystemPrompt("implementer", skills);
    for (const skill of skills) {
      expect(prompt).toContain(skill.body);
    }
  });
});
