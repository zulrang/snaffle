#!/usr/bin/env node
/**
 * Node ship-target entry for the `snaffle` CLI (D17/D18).
 * ponytail: delegates to tsx loader; upgrade path is prebuilt dist/ if cold-start matters.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const cli = join(root, "src/cli.ts");

try {
  require.resolve("tsx");
} catch {
  console.error(
    "Missing dependency `tsx`. Run `npm install` or `bun run setup` in the Snaffle repo.",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
