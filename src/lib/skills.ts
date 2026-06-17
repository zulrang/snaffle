import { readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../domain/shared";

/**
 * Flat Pi skill library loader (D2, D12, W1).
 *
 * Skills are doctrine, not logic: each `SKILL.md` tells an agent how to invoke
 * the relevant `lib/` scripts and never reimplements them (D12). The loader is
 * deterministic `lib/` code; the composed agent prompt is assembled elsewhere
 * (`agent-context.ts`).
 */

export type SkillName =
  | "spec-authoring"
  | "planning"
  | "implementation"
  | "test-authoring"
  | "commit-pr";

export const SKILL_NAMES: readonly SkillName[] = [
  "spec-authoring",
  "planning",
  "implementation",
  "test-authoring",
  "commit-pr",
];

/** Skills ship as markdown under this package-relative directory. */
export const SKILLS_DIR = "src/skills";

const SKILL_FILES: Readonly<Record<SkillName, string>> = {
  "spec-authoring": "spec-authoring.md",
  planning: "planning.md",
  implementation: "implementation.md",
  "test-authoring": "test-authoring.md",
  "commit-pr": "commit-pr.md",
};

export interface Skill {
  readonly name: SkillName;
  readonly version: string;
  readonly body: string;
  /** `lib/` entry points the skill references — it points to logic, never copies it (D12). */
  readonly libReferences: readonly string[];
}

export type SkillLoadError =
  | { readonly kind: "skill_not_found"; readonly name: SkillName; readonly detail: string }
  | { readonly kind: "missing_version"; readonly name: SkillName }
  | { readonly kind: "reimplements_lib"; readonly name: SkillName; readonly detail: string };

const VERSION_RE = /<!--\s*skill-version:\s*([^\s]+)\s*-->/;
const LIB_REF_RE = /src\/lib\/[\w./-]+/g;
// A doctrine skill carries no TS implementation; this catches a skill that copies
// lib logic into a fenced block instead of referencing it (D12 guardrail).
const IMPL_RE = /\bexport\s+(?:function|const|class)\b/;

const extractLibReferences = (body: string): readonly string[] => [
  ...new Set(body.match(LIB_REF_RE) ?? []),
];

/** Load and validate one skill by name from the package skills directory. */
export const loadSkill = (name: SkillName, repoRoot: string): Result<Skill, SkillLoadError> => {
  const path = join(repoRoot, SKILLS_DIR, SKILL_FILES[name]);
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    return err({
      kind: "skill_not_found",
      name,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const versionMatch = body.match(VERSION_RE);
  if (versionMatch?.[1] === undefined) {
    return err({ kind: "missing_version", name });
  }

  if (IMPL_RE.test(body)) {
    return err({
      kind: "reimplements_lib",
      name,
      detail: "skill body contains a TS export; skills reference lib/, never reimplement it (D12)",
    });
  }

  return ok({
    name,
    version: versionMatch[1],
    body,
    libReferences: extractLibReferences(body),
  });
};

/** Compose a named skill set, short-circuiting on the first load/validation error. */
export const loadSkills = (
  names: readonly SkillName[],
  repoRoot: string,
): Result<readonly Skill[], SkillLoadError> => {
  const skills: Skill[] = [];
  for (const name of names) {
    const loaded = loadSkill(name, repoRoot);
    if (!loaded.ok) return loaded;
    skills.push(loaded.value);
  }
  return ok(skills);
};
