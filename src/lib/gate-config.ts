import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateCheckKind } from "../domain/gate";
import { err, ok, type Result } from "../domain/shared";

/**
 * Project gate configuration (D8, W5).
 *
 * Phase 1 runs a single configured check — this repo's `bun run check` script.
 * The command is read from the worktree's package.json when present.
 */

export interface ProjectGateConfig {
  readonly command: readonly string[];
  readonly checkKind: GateCheckKind;
}

export const PHASE1_GATE_CHECK_KIND = "full_tests" as const satisfies GateCheckKind;

export const defaultPhase1GateConfig = (): ProjectGateConfig => ({
  command: ["bun", "run", "check"],
  checkKind: PHASE1_GATE_CHECK_KIND,
});

export type GateConfigError =
  | { readonly kind: "missing_package_json"; readonly worktreeRoot: string }
  | { readonly kind: "missing_check_script"; readonly worktreeRoot: string }
  | {
      readonly kind: "invalid_package_json";
      readonly worktreeRoot: string;
      readonly detail: string;
    };

/** Load the gate command declared in a worktree's package.json. */
export const loadGateConfig = (
  worktreeRoot: string,
): Result<ProjectGateConfig, GateConfigError> => {
  const packagePath = join(worktreeRoot, "package.json");
  try {
    const raw = readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: { check?: unknown } };
    if (typeof parsed.scripts?.check !== "string" || parsed.scripts.check.trim().length === 0) {
      return err({ kind: "missing_check_script", worktreeRoot });
    }
    return ok({
      command: ["bun", "run", "check"],
      checkKind: PHASE1_GATE_CHECK_KIND,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return err({ kind: "missing_package_json", worktreeRoot });
    }
    return err({
      kind: "invalid_package_json",
      worktreeRoot,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
