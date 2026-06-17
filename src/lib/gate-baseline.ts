import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GateCheckResult, GateReport } from "../domain/gate";
import { failedChecks } from "../domain/gate";
import { type ContentHash, err, ok, parseContentHash, type Result } from "../domain/shared";
import { hashCanonicalJson } from "./provenance-hash";

/**
 * Characterization baseline for wrap mode (D16, S2/W5).
 *
 * Captures known-red gate failures so PRE refuses only on regression, not on an
 * already-red tree.
 */

export interface GateBaselineSnapshot {
  readonly hash: ContentHash;
  readonly failedCheckKeys: readonly string[];
  readonly capturedAt: number;
}

export const fingerprintFailedCheck = (check: GateCheckResult): string =>
  `${check.kind}:${check.detail ?? ""}`;

export const captureGateBaseline = (report: GateReport): GateBaselineSnapshot => {
  const failedCheckKeys = failedChecks(report)
    .map(fingerprintFailedCheck)
    .sort((a, b) => a.localeCompare(b));
  return {
    hash: hashCanonicalJson({ failedCheckKeys }),
    failedCheckKeys,
    capturedAt: report.ranAt,
  };
};

export const saveGateBaseline = (
  worktreeRoot: string,
  relPath: string,
  baseline: GateBaselineSnapshot,
): Result<void, { readonly kind: "write_error"; readonly detail: string }> => {
  try {
    mkdirSync(dirname(join(worktreeRoot, relPath)), { recursive: true });
    writeFileSync(join(worktreeRoot, relPath), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    return ok(undefined);
  } catch (error) {
    return err({
      kind: "write_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

export const loadGateBaseline = (
  worktreeRoot: string,
  relPath: string,
): Result<
  GateBaselineSnapshot | undefined,
  { readonly kind: "parse_error"; readonly detail: string }
> => {
  try {
    const raw = readFileSync(join(worktreeRoot, relPath), "utf8");
    const parsed = JSON.parse(raw) as {
      hash?: unknown;
      failedCheckKeys?: unknown;
      capturedAt?: unknown;
    };
    if (typeof parsed.hash !== "string" || !Array.isArray(parsed.failedCheckKeys)) {
      return err({ kind: "parse_error", detail: "invalid baseline shape" });
    }
    const hash = parseContentHash(parsed.hash);
    if (!hash.ok) return err({ kind: "parse_error", detail: "invalid baseline hash" });
    const failedCheckKeys = parsed.failedCheckKeys.filter(
      (key): key is string => typeof key === "string",
    );
    const capturedAt = typeof parsed.capturedAt === "number" ? parsed.capturedAt : 0;
    const baseline: GateBaselineSnapshot = {
      hash: hash.value,
      failedCheckKeys,
      capturedAt,
    };
    const recomputed = hashCanonicalJson({ failedCheckKeys: baseline.failedCheckKeys });
    if (recomputed !== baseline.hash) {
      return err({ kind: "parse_error", detail: "baseline hash mismatch" });
    }
    return ok(baseline);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ok(undefined);
    return err({
      kind: "parse_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

/** True when the report introduces failures absent from the baseline. */
export const hasRegressionFromBaseline = (
  report: GateReport,
  baseline: GateBaselineSnapshot,
): boolean => {
  const baselineSet = new Set(baseline.failedCheckKeys);
  const currentFailed = failedChecks(report).map(fingerprintFailedCheck);
  return currentFailed.some((key) => !baselineSet.has(key));
};

export const failedCheckKeySet = (baseline: GateBaselineSnapshot): ReadonlySet<string> =>
  new Set(baseline.failedCheckKeys);
