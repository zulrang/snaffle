import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../domain/shared";
import {
  DEFAULT_CONTRACT_BASELINE_REL,
  DEFAULT_GATE_BASELINE_REL,
  DEFAULT_GATE_CONFIG_REL,
  defaultGreenfieldGateConfigToml,
  writeDefaultPackageJson,
} from "./gate-config";

/**
 * Greenfield gate bootstrap (D16, S3/W6).
 *
 * Materializes gate config and a runnable check harness on an empty repo.
 */

export type GreenfieldBootstrapError =
  | { readonly kind: "write_error"; readonly detail: string }
  | { readonly kind: "already_bootstrapped" };

export interface GreenfieldBootstrapResult {
  readonly gateConfigPath: string;
  readonly packageJsonPath: string;
  readonly gateBaselinePath: string;
  readonly contractBaselinePath: string;
}

const EMPTY_BASELINE = {
  hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  failedCheckKeys: [],
  capturedAt: 0,
};

export const bootstrapGreenfieldGate = (
  repoRoot: string,
): Result<GreenfieldBootstrapResult, GreenfieldBootstrapError> => {
  const gateConfigPath = join(repoRoot, DEFAULT_GATE_CONFIG_REL);
  if (existsSync(gateConfigPath)) {
    return err({ kind: "already_bootstrapped" });
  }

  try {
    mkdirSync(join(repoRoot, ".orchestrator"), { recursive: true });
    writeFileSync(gateConfigPath, defaultGreenfieldGateConfigToml(), "utf8");
    writeDefaultPackageJson(repoRoot);
    writeFileSync(
      join(repoRoot, DEFAULT_GATE_BASELINE_REL),
      `${JSON.stringify(EMPTY_BASELINE, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(repoRoot, DEFAULT_CONTRACT_BASELINE_REL), "{}\n", "utf8");

    return ok({
      gateConfigPath,
      packageJsonPath: join(repoRoot, "package.json"),
      gateBaselinePath: join(repoRoot, DEFAULT_GATE_BASELINE_REL),
      contractBaselinePath: join(repoRoot, DEFAULT_CONTRACT_BASELINE_REL),
    });
  } catch (error) {
    return err({
      kind: "write_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
