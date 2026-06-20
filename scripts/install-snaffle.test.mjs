import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CANONICAL_SKILL_REL,
  installSkills,
  PROJECT_TARGETS,
  resolveInstallTargets,
  resolveSetupRuntime,
} from "./install-snaffle.mjs";

test("resolveInstallTargets lists project pi, cursor skill, and cursor rule paths", () => {
  const root = "/repo";
  const { skillSrc, targets } = resolveInstallTargets(root);
  assert.equal(skillSrc, join(root, CANONICAL_SKILL_REL));
  assert.equal(targets.length, 3);
  assert.deepEqual(
    targets.map((t) => t.path),
    [
      join(root, PROJECT_TARGETS.piSkill),
      join(root, PROJECT_TARGETS.cursorSkill),
      join(root, PROJECT_TARGETS.cursorRule),
    ],
  );
});

test("installSkills copies canonical skill into cursor project skill path", () => {
  const root = mkdtempSync(join(tmpdir(), "snaffle-install-"));
  const skillBody = "---\nname: snaffle\ndescription: test\n---\n\n# body\n";
  const skillDir = join(root, ".pi/skills/snaffle");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillBody);
  mkdirSync(join(root, ".cursor/rules"), { recursive: true });
  writeFileSync(join(root, ".cursor/rules/snaffle.mdc"), "# rule\n");

  installSkills(root);
  const cursorSkill = readFileSync(join(root, PROJECT_TARGETS.cursorSkill), "utf8");
  assert.equal(cursorSkill, skillBody);

  rmSync(root, { recursive: true, force: true });
});

test("resolveSetupRuntime prefers bun when both runtimes are available", () => {
  assert.equal(resolveSetupRuntime(["--node"]), "node");
  assert.equal(resolveSetupRuntime(["--bun"]), "bun");
});
