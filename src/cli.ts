#!/usr/bin/env bun
import {
  type DecisionsCommand,
  listPendingDecisions,
  recordDecisionForLineage,
} from "./spine/decisions-cli.ts";
import { type EscapesCommand, listEscapes, reportEscapeClusters } from "./spine/escapes-cli.ts";
import { type Phase1RunError, readPhase1Status, runPhase1 } from "./spine/phase1-cli.ts";
import { runRegimeLineage } from "./spine/regime-cli.ts";
import type { SkeletonVariant } from "./spine/skeleton-run.ts";

const VARIANTS = ["merge_success", "scope_blocked", "post_gate_rejected"] as const;

const usage = (): void => {
  console.error(`usage:
  orchestrator run [--repo <path>] [--legacy-skeleton] [--variant ${VARIANTS.join("|")}] [--owner <id>]
  orchestrator status [--repo <path>] [--limit <n>]
  orchestrator decisions list [--repo <path>]
  orchestrator decisions approve|reject --lineage <id> [--repo <path>]
  orchestrator escapes list|report [--repo <path>]`);
};

const isEscapesCommand = (value: string): value is EscapesCommand =>
  value === "list" || value === "report";

const isVariant = (value: string): value is SkeletonVariant =>
  (VARIANTS as readonly string[]).includes(value);

const isDecisionsCommand = (value: string): value is DecisionsCommand =>
  value === "list" || value === "approve" || value === "reject";

export interface ParsedCli {
  readonly command: "run" | "status" | "decisions" | "escapes";
  readonly repoRoot: string;
  readonly variant: SkeletonVariant;
  readonly legacySkeleton: boolean;
  readonly ownerId?: string;
  readonly provenanceLimit: number;
  readonly decisionsCommand?: DecisionsCommand;
  readonly escapesCommand?: EscapesCommand;
  readonly lineageId?: string;
}

export const parseCliArgs = (argv: readonly string[]): ParsedCli | undefined => {
  const command = argv[0];
  if (
    command !== "run" &&
    command !== "status" &&
    command !== "decisions" &&
    command !== "escapes"
  ) {
    return undefined;
  }

  let repoRoot = process.cwd();
  let variant: SkeletonVariant = "merge_success";
  let legacySkeleton = false;
  let ownerId: string | undefined;
  let provenanceLimit = 10;
  let decisionsCommand: DecisionsCommand | undefined;
  let lineageId: string | undefined;

  let escapesCommand: EscapesCommand | undefined;

  if (command === "decisions") {
    const sub = argv[1];
    if (sub === undefined || !isDecisionsCommand(sub)) return undefined;
    decisionsCommand = sub;
  }

  if (command === "escapes") {
    const sub = argv[1];
    if (sub === undefined || !isEscapesCommand(sub)) return undefined;
    escapesCommand = sub;
  }

  const start = command === "decisions" || command === "escapes" ? 2 : 1;
  for (let i = start; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--repo" && next !== undefined) {
      repoRoot = next;
      i += 1;
    } else if (flag === "--variant" && next !== undefined) {
      if (!isVariant(next)) return undefined;
      variant = next;
      i += 1;
    } else if (flag === "--legacy-skeleton") {
      legacySkeleton = true;
    } else if (flag === "--owner" && next !== undefined) {
      ownerId = next;
      i += 1;
    } else if (flag === "--limit" && next !== undefined) {
      provenanceLimit = Number(next);
      if (!Number.isInteger(provenanceLimit) || provenanceLimit <= 0) return undefined;
      i += 1;
    } else if (flag === "--lineage" && next !== undefined) {
      lineageId = next;
      i += 1;
    } else {
      return undefined;
    }
  }

  if (command === "decisions") {
    if (decisionsCommand === undefined) return undefined;
    if (
      (decisionsCommand === "approve" || decisionsCommand === "reject") &&
      (lineageId === undefined || lineageId.length === 0)
    ) {
      return undefined;
    }
  }

  return {
    command,
    repoRoot,
    variant,
    legacySkeleton,
    ...(ownerId === undefined ? {} : { ownerId }),
    provenanceLimit,
    ...(decisionsCommand === undefined ? {} : { decisionsCommand }),
    ...(escapesCommand === undefined ? {} : { escapesCommand }),
    ...(lineageId === undefined ? {} : { lineageId }),
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

  if (parsed.command === "decisions") {
    if (parsed.decisionsCommand === "list") {
      const listed = listPendingDecisions(parsed.repoRoot);
      if (!listed.ok) {
        console.error(JSON.stringify({ ok: false, error: listed.error }));
        return 2;
      }
      console.log(JSON.stringify({ ok: true, ...listed.value }, null, 2));
      return 0;
    }

    const recorded = recordDecisionForLineage(
      parsed.repoRoot,
      parsed.lineageId as string,
      parsed.decisionsCommand as "approve" | "reject",
    );
    if (!recorded.ok) {
      console.error(JSON.stringify({ ok: false, error: recorded.error }));
      return 2;
    }
    console.log(JSON.stringify({ ok: true, ...recorded.value }, null, 2));
    return 0;
  }

  if (parsed.command === "escapes") {
    if (parsed.escapesCommand === "list") {
      const listed = listEscapes(parsed.repoRoot);
      if (!listed.ok) {
        console.error(JSON.stringify({ ok: false, error: listed.error }));
        return 2;
      }
      console.log(JSON.stringify({ ok: true, ...listed.value }, null, 2));
      return 0;
    }

    const report = reportEscapeClusters(parsed.repoRoot);
    if (!report.ok) {
      console.error(JSON.stringify({ ok: false, error: report.error }));
      return 2;
    }
    console.log(JSON.stringify({ ok: true, ...report.value }, null, 2));
    return 0;
  }

  if (parsed.legacySkeleton) {
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
  }

  const regime = await runRegimeLineage({ repoRoot: parsed.repoRoot });
  if (!regime.ok) {
    console.error(JSON.stringify({ ok: false, error: regime.error }));
    return 2;
  }

  console.log(JSON.stringify({ ok: true, outcome: regime.value }, null, 2));
  if (regime.value.terminal.kind === "merged") return 0;
  return 1;
};

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
