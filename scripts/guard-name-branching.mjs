#!/usr/bin/env node
/**
 * W10 — name-branching guardrail (D15). Flags gate-stage string literal
 * branching in control-plane code (lib/ + spine/, excluding tests).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["src/lib", "src/spine"];
const SKIP = /\.test\.(ts|tsx)$/;
const ALLOW = new Set([
  "src/lib/gate-config.ts",
  "src/lib/gate-runner.ts",
  "src/domain/gate.ts",
]);

const STAGE_LITERAL_BRANCH =
  /\b(?:if|else\s+if|switch|case|\?\?|\|\|)\s*[^;\n]*===\s*["'](?:format|lint|types|affected_tests|full_tests|contract_diff)["']/;

/** @param {string} dir @param {string} base @returns {string[]} */
const collectFiles = (dir, base) => {
  const abs = join(base, dir);
  const entries = readdirSync(abs);
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const path = join(abs, entry);
    const rel = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      files.push(...collectFiles(rel, base));
    } else if (entry.endsWith(".ts") && !SKIP.test(entry) && !ALLOW.has(rel)) {
      files.push(path);
    }
  }
  return files;
};

/** @type {{ file: string; line: number; text: string }[]} */
const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of collectFiles(dir, ROOT)) {
    const content = readFileSync(file, "utf8");
    for (const [i, line] of content.split("\n").entries()) {
      if (STAGE_LITERAL_BRANCH.test(line)) {
        violations.push({
          file: file.slice(ROOT.length + 1),
          line: i + 1,
          text: line.trim(),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("name-branching guard failed (D15):");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.text}`);
  }
  process.exit(1);
}

console.log("name-branching guard: ok");
