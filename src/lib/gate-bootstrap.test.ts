import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatePassed } from "../domain/gate";
import { GateRunId, LineageId } from "../domain/ids";
import { bootstrapGreenfieldGate } from "./gate-bootstrap";
import { DEFAULT_GATE_CONFIG_REL, loadGateConfig } from "./gate-config";
import { runPreGate } from "./gate-runner";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("S3/W6 — greenfield bootstrap", () => {
  test("bootstraps gate harness from config alone with green PRE", async () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-greenfield-"));

    const boot = must(bootstrapGreenfieldGate(root));
    expect(readFileSync(boot.gateConfigPath, "utf8")).toContain('repo_mode = "greenfield"');

    const config = must(loadGateConfig(root));
    expect(config.repoMode).toBe("greenfield");

    const pre = await runPreGate({
      gateRunId: must(GateRunId("gate-green-pre")),
      lineageId: must(LineageId("lineage-green")),
      worktreeRoot: root,
      config,
    });
    expect(gatePassed(pre)).toBe(true);
    expect(readFileSync(join(root, DEFAULT_GATE_CONFIG_REL), "utf8")).toContain("full_tests");

    rmSync(root, { recursive: true, force: true });
  });
});
