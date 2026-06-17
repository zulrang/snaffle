import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GATE_CONFIG_REL } from "./gate-config";
import {
  defaultOrchestratorConfig,
  loadOrchestratorConfig,
  parseOrchestratorToml,
} from "./orchestrator-config";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("W1 — orchestrator config loader (D15/D18/D22)", () => {
  test("parses door, tier, and budget sections from gate.toml", () => {
    const config = must(
      parseOrchestratorToml(`
tier = "full"

[door]
auth = ["**/auth/**", "src/security/**"]
money = ["**/billing/**"]

[door.tags]
auth = ["authentication"]

[tiers.light]
provider = "anthropic"
model = "claude-haiku"

[tiers.mid]
provider = "anthropic"
model = "claude-sonnet"
version = "20250514"

[tiers.heavy]
provider = "anthropic"
model = "claude-opus"

[budget]
rolling_window_tokens = 2000000
session_tokens = 200000
per_change_tokens = 80000
kill_switch_tokens = 3000000
`),
    );

    expect(config.door.pathPatterns.auth).toEqual(["**/auth/**", "src/security/**"]);
    expect(config.door.pathPatterns.money).toEqual(["**/billing/**"]);
    expect(config.door.tagPatterns.auth).toEqual(["authentication"]);
    expect(config.tiers.light).toEqual({ provider: "anthropic", model: "claude-haiku" });
    expect(config.tiers.mid).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
      version: "20250514",
    });
    expect(config.budget.rollingWindowTokens).toBe(2_000_000);
    expect(config.budget.killSwitchTokens).toBe(3_000_000);
  });

  test("absent sections fall back to documented defaults", () => {
    const config = must(parseOrchestratorToml('tier = "full"\n'));
    const defaults = defaultOrchestratorConfig();
    expect(config.door).toEqual(defaults.door);
    expect(config.tiers).toEqual(defaults.tiers);
    expect(config.budget).toEqual(defaults.budget);
  });

  test("missing gate.toml yields defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-no-gate-"));
    const config = must(loadOrchestratorConfig(root));
    expect(config).toEqual(defaultOrchestratorConfig());
    rmSync(root, { recursive: true, force: true });
  });

  test("invalid trigger name fails closed", () => {
    const result = parseOrchestratorToml(`
[door]
not_a_trigger = ["**/foo/**"]
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unknown_door_trigger");
  });

  test("invalid tier table fails closed without partial config", () => {
    const result = parseOrchestratorToml(`
[tiers.light]
provider = ""
model = "x"
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_tier");
  });

  test("invalid budget fails closed", () => {
    const result = parseOrchestratorToml(`
[budget]
session_tokens = -1
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_budget");
  });

  test("loads from worktree gate.toml path", () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-gate-toml-"));
    mkdirSync(join(root, ".orchestrator"), { recursive: true });
    writeFileSync(
      join(root, DEFAULT_GATE_CONFIG_REL),
      `[door]\npersisted_schema = ["**/migrations/**"]\n`,
    );
    const config = must(loadOrchestratorConfig(root));
    expect(config.door.pathPatterns.persisted_schema).toEqual(["**/migrations/**"]);
    rmSync(root, { recursive: true, force: true });
  });
});
