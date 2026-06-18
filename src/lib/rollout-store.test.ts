import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageId } from "../domain/ids";
import { parseTimestamp } from "../domain/shared";
import { loadLastRollout, saveLastRollout } from "./rollout-store";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("rollout store", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("save and load last rollout round-trip", () => {
    workspace = mkdtempSync(join(tmpdir(), "rollout-store-"));
    const ts = must(parseTimestamp(1));
    must(
      saveLastRollout(workspace, {
        lineageId: must(LineageId("L-store")),
        outcome: { kind: "armed" },
        recordedAt: ts,
        operatorAcknowledged: false,
      }),
    );
    const loaded = must(loadLastRollout(workspace));
    expect(loaded?.outcome.kind).toBe("armed");
  });
});
