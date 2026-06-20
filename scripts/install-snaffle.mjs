#!/usr/bin/env node
/**
 * End-user setup: install deps, link global `snaffle` CLI, and install Pi + Cursor routing skills.
 *
 * Usage:
 *   node scripts/install-snaffle.mjs [--global] [--skip-link] [--node | --bun]
 *   npm run setup
 *   bun run setup
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical routing skill shipped in-repo (Pi Agent Skills layout). */
export const CANONICAL_SKILL_REL = ".pi/skills/snaffle/SKILL.md";

export const PROJECT_TARGETS = {
  piSkill: ".pi/skills/snaffle/SKILL.md",
  cursorSkill: ".cursor/skills/snaffle/SKILL.md",
  cursorRule: ".cursor/rules/snaffle.mdc",
};

export const GLOBAL_TARGETS = {
  piSkill: ".pi/agent/skills/snaffle/SKILL.md",
  cursorSkill: ".cursor/skills/snaffle/SKILL.md",
};

/** Resolve install destinations relative to repo root and optional home dir. */
export const resolveInstallTargets = (root, { global = false } = {}) => {
  const skillSrc = join(root, CANONICAL_SKILL_REL);
  const project = [
    { kind: "skill", path: join(root, PROJECT_TARGETS.piSkill) },
    { kind: "skill", path: join(root, PROJECT_TARGETS.cursorSkill) },
    { kind: "rule", path: join(root, PROJECT_TARGETS.cursorRule) },
  ];
  if (!global) return { skillSrc, targets: project };

  const home = homedir();
  return {
    skillSrc,
    targets: [
      ...project,
      { kind: "skill", path: join(home, GLOBAL_TARGETS.piSkill) },
      { kind: "skill", path: join(home, GLOBAL_TARGETS.cursorSkill) },
    ],
  };
};

const hasBun = () => {
  try {
    execSync("bun --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

const hasNode = () => {
  try {
    const version = execSync("node --version", { encoding: "utf8" }).trim().replace(/^v/, "");
    const major = Number(version.split(".")[0]);
    return Number.isFinite(major) && major >= 22;
  } catch {
    return false;
  }
};

/** Pick install/link runtime: explicit flag wins, else Bun when present, else Node. */
export const resolveSetupRuntime = (args) => {
  if (args.includes("--node")) {
    return hasNode() ? "node" : null;
  }
  if (args.includes("--bun")) {
    return hasBun() ? "bun" : null;
  }
  if (hasBun()) return "bun";
  if (hasNode()) return "node";
  return null;
};

/** Copy canonical skill into skill targets; verify the Cursor rule file exists in-repo. */
export const installSkills = (root, options = {}) => {
  const { skillSrc, targets } = resolveInstallTargets(root, options);
  if (!existsSync(skillSrc)) {
    throw new Error(`canonical skill missing: ${skillSrc}`);
  }

  for (const target of targets) {
    if (target.kind === "rule") {
      if (!existsSync(target.path)) {
        throw new Error(
          `cursor rule missing: ${target.path} (commit .cursor/rules/snaffle.mdc or restore from git)`,
        );
      }
      continue;
    }

    if (target.path === skillSrc) continue;
    mkdirSync(dirname(target.path), { recursive: true });
    cpSync(skillSrc, target.path);
  }

  return { skillSrc, installedSkillPaths: targets.filter((t) => t.kind === "skill").map((t) => t.path) };
};

const run = (cmd) => {
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
};

const main = () => {
  const args = process.argv.slice(2);
  const global = args.includes("--global");
  const skipLink = args.includes("--skip-link");
  const runtime = resolveSetupRuntime(args);

  if (!runtime) {
    console.error("Node >= 22 or Bun >= 1.3 is required.");
    console.error("Install Node from https://nodejs.org or Bun from https://bun.com");
    process.exit(1);
  }

  if (runtime === "bun") {
    run("bun install");
    if (!skipLink) run("bun link");
  } else {
    run("npm install");
    if (!skipLink) run("npm link");
  }

  const result = installSkills(ROOT, { global });
  const lines = [
    "Snaffle setup complete.",
    `- runtime: ${runtime}`,
    `- canonical skill: ${result.skillSrc}`,
    `- project skills: ${PROJECT_TARGETS.piSkill}, ${PROJECT_TARGETS.cursorSkill}`,
    `- cursor rule: ${PROJECT_TARGETS.cursorRule}`,
  ];
  if (!skipLink) {
    lines.push("- global CLI: `snaffle` (via link; runs on Node via bin/snaffle.mjs)");
  }
  if (global) {
    lines.push(`- global skills: ${GLOBAL_TARGETS.piSkill}, ${GLOBAL_TARGETS.cursorSkill}`);
  } else {
    lines.push("- tip: rerun with --global to also install skills under your home directory");
  }
  console.log(lines.join("\n"));
};

const entry = process.argv[1] ? fileURLToPath(import.meta.url) : "";
if (entry && entry === process.argv[1]) {
  main();
}
