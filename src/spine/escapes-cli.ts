import { join } from "node:path";
import { err, ok, type Result } from "../domain/shared";
import {
  ESCAPE_DB_DIR,
  ESCAPE_DB_FILE,
  type OracleEscapeCluster,
  type OracleEscapeRecord,
  openOracleEscapeStore,
} from "../lib/oracle-escape";

/**
 * W7 — oracle escape cluster report CLI (D24).
 */

export type EscapesCommand = "list" | "report";

export type EscapesCliError = { readonly kind: "store_error"; readonly detail: string };

export interface EscapesListOutcome {
  readonly escapes: readonly OracleEscapeRecord[];
}

export interface EscapesReportOutcome {
  readonly clusters: readonly OracleEscapeCluster[];
}

const escapeDbPath = (repoRoot: string): string => join(repoRoot, ESCAPE_DB_DIR, ESCAPE_DB_FILE);

const openStore = (repoRoot: string) => openOracleEscapeStore(escapeDbPath(repoRoot));

export const listEscapes = (repoRoot: string): Result<EscapesListOutcome, EscapesCliError> => {
  const store = openStore(repoRoot);
  try {
    const clusters = store.clusterByCriterion();
    if (!clusters.ok) return err({ kind: "store_error", detail: JSON.stringify(clusters.error) });
    const escapes: OracleEscapeRecord[] = [];
    for (const cluster of clusters.value) {
      for (const lineageId of cluster.lineageIds) {
        const listed = store.listByLineage(lineageId);
        if (!listed.ok) return err({ kind: "store_error", detail: JSON.stringify(listed.error) });
        escapes.push(...listed.value);
      }
    }
    return ok({ escapes });
  } finally {
    store.close();
  }
};

export const reportEscapeClusters = (
  repoRoot: string,
): Result<EscapesReportOutcome, EscapesCliError> => {
  const store = openStore(repoRoot);
  try {
    const clusters = store.clusterByCriterion();
    if (!clusters.ok) return err({ kind: "store_error", detail: JSON.stringify(clusters.error) });
    return ok({ clusters: clusters.value });
  } finally {
    store.close();
  }
};
