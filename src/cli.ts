#!/usr/bin/env bun
import { type Phase1RunError, readPhase1Status, runPhase1 } from "./spine/phase1-cli.ts";
import type { SkeletonVariant } from "./spine/skeleton-run.ts";

const VARIANTS = ["merge_success", "scope_blocked", "post_gate_rejected"] as const;

const usage = (): void => {
  console.error(`usage:
  orchestrator run [--repo <path>] [--variant ${VARIANTS.join("|")}] [--owner <id>]
  orchestrator status [--repo <path>] [--limit <n>]`);
};

const isVariant = (value: string): value is SkeletonVariant =>
  (VARIANTS as readonly string[]).includes(value);

export interface ParsedCli {
  readonly command: "run" | "status";
  readonly repoRoot: string;
  readonly variant: SkeletonVariant;
  readonly ownerId?: string;
  readonly provenanceLimit: number;
}

export const parseCliArgs = (argv: readonly string[]): ParsedCli | undefined => {
  const command = argv[0];
  if (command !== "run" && command !== "status") return undefined;

  let repoRoot = process.cwd();
  let variant: SkeletonVariant = "merge_success";
  let ownerId: string | undefined;
  let provenanceLimit = 10;

  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--repo" && next !== undefined) {
      repoRoot = next;
      i += 1;
    } else if (flag === "--variant" && next !== undefined) {
      if (!isVariant(next)) return undefined;
      variant = next;
      i += 1;
    } else if (flag === "--owner" && next !== undefined) {
      ownerId = next;
      i += 1;
    } else if (flag === "--limit" && next !== undefined) {
      provenanceLimit = Number(next);
      if (!Number.isInteger(provenanceLimit) || provenanceLimit <= 0) return undefined;
      i += 1;
    } else {
      return undefined;
    }
  }

  return {
    command,
    repoRoot,
    variant,
    ...(ownerId === undefined ? {} : { ownerId }),
    provenanceLimit,
  };
};

const exitCodeForRunError = (error: Phase1RunError): number => {
  if (error.kind === "workspace_lock") return 3;
  return 2;
};

const main = async (): Promise<number> => {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    usage();
    return 2;
  }

  if (parsed.command === "status") {
    const status = await readPhase1Status(parsed.repoRoot, {
      provenanceLimit: parsed.provenanceLimit,
    });
    if (!status.ok) {
      console.error(JSON.stringify({ ok: false, error: status.error }));
      return 2;
    }
    console.log(JSON.stringify({ ok: true, status: status.value }, null, 2));
    return 0;
  }

  const outcome = await runPhase1({
    repoRoot: parsed.repoRoot,
    variant: parsed.variant,
    ...(parsed.ownerId === undefined ? {} : { ownerId: parsed.ownerId }),
  });

  if (!outcome.ok) {
    console.error(JSON.stringify({ ok: false, error: outcome.error }));
    return exitCodeForRunError(outcome.error);
  }

  console.log(JSON.stringify({ ok: true, outcome: outcome.value }, null, 2));
  if (outcome.value.kind === "merged") return 0;
  return 1;
};

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
