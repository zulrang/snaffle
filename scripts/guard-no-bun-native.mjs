#!/usr/bin/env node
/**
 * Fail CI when Bun-native APIs appear in shipped src/ (D17/D18).
 *
 * ponytail: regex scan — upgrade path is a ts-morph rule (D15) if regressions slip through.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = "src";
const EXCLUDED_PREFIXES = ["lib/fixtures/"];
const EXCLUDED_SUFFIXES = [".test.ts"];

/** @param {string} dir @param {string[]} files */
const walk = (dir, files = []) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, files);
    } else if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
};

/** @param {string} relPath */
const isExcluded = (relPath) =>
  EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix)) ||
  EXCLUDED_SUFFIXES.some((suffix) => relPath.endsWith(suffix));

/** @type {string[]} */
const violations = [];

/** @param {string} content */
const scanForViolations = (content) => {
  const withoutStrings = content
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/gs, "``");
  return /from\s+["']bun:/.test(withoutStrings) || /\bBun\./.test(withoutStrings);
};

for (const file of walk(SRC_ROOT)) {
  const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
  if (isExcluded(rel)) continue;

  const content = readFileSync(file, "utf8");
  if (scanForViolations(content)) {
    violations.push(rel);
  }
}

if (violations.length > 0) {
  console.error("Bun-native references in shipped src/ (outside fixtures and *.test.ts):");
  for (const file of violations) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

console.log("guard-no-bun-native: ok");
