import { readFileSync } from "node:fs";
import { join } from "node:path";
import TOML from "smol-toml";
import { ONE_WAY_TRIGGERS, type OneWayTrigger } from "../domain/door";
import { err, ok, type Result } from "../domain/shared";
import { DEFAULT_GATE_CONFIG_REL } from "./gate-config";
import type { GovernancePolicy } from "./governance-policy";
import { defaultGovernancePolicy, parseGovernanceSection } from "./governance-policy";

/**
 * Orchestrator control-plane config (D15, D18, D22) — door taxonomy, tier mapping,
 * budget limits. Parsed from the same `.snaffle/gate.toml` as gate stages
 * (cut line: fold sections before a separate config file).
 */

export type ModelTier = "light" | "mid" | "heavy";

export const MODEL_TIERS: readonly ModelTier[] = ["light", "mid", "heavy"];

export interface ModelRef {
  readonly provider: string;
  readonly model: string;
  readonly version?: string;
}

export interface DoorTaxonomyConfig {
  /** Path glob patterns keyed by trigger — only keys present in config are active. */
  readonly pathPatterns: Readonly<Partial<Record<OneWayTrigger, readonly string[]>>>;
  /** Tag literals keyed by trigger — optional hints from admission. */
  readonly tagPatterns: Readonly<Partial<Record<OneWayTrigger, readonly string[]>>>;
}

export interface BudgetLimits {
  readonly rollingWindowTokens: number;
  readonly sessionTokens: number;
  readonly perChangeTokens: number;
  readonly killSwitchTokens: number;
  /** When true, counters persist to SQLite (W4/W11). */
  readonly persist: boolean;
}
export interface HitlConfig {
  /** Fraction of two-way merges enqueued for human sampling (0..1, D11). */
  readonly twoWaySampleRate: number;
}

export type RolloutAdapter = "injected" | "live";

export interface RolloutConfig {
  readonly enabled: boolean;
  readonly adapter: RolloutAdapter;
  readonly flagName: string;
  readonly metricRef: string;
  readonly threshold: number;
  readonly pollIntervalMs: number;
  readonly webhookBaseUrl: string;
}

export interface TierTable {
  readonly light: ModelRef;
  readonly mid: ModelRef;
  readonly heavy: ModelRef;
}

export interface OrchestratorConfig {
  readonly door: DoorTaxonomyConfig;
  readonly tiers: TierTable;
  readonly budget: BudgetLimits;
  readonly hitl: HitlConfig;
  readonly rollout: RolloutConfig;
  readonly governance: GovernancePolicy;
}

export type OrchestratorConfigError =
  | { readonly kind: "missing_gate_toml"; readonly worktreeRoot: string }
  | { readonly kind: "invalid_gate_toml"; readonly detail: string }
  | { readonly kind: "unknown_door_trigger"; readonly trigger: string }
  | { readonly kind: "invalid_door_patterns"; readonly trigger: string; readonly detail: string }
  | { readonly kind: "invalid_tier"; readonly tier: string; readonly detail: string }
  | { readonly kind: "invalid_budget"; readonly detail: string };

const isOneWayTrigger = (value: string): value is OneWayTrigger =>
  (ONE_WAY_TRIGGERS as readonly string[]).includes(value);

const parseStringArray = (
  raw: unknown,
  label: string,
): Result<readonly string[], OrchestratorConfigError> => {
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    return err({ kind: "invalid_gate_toml", detail: `${label} must be an array of strings` });
  }
  const values = raw as string[];
  if (values.some((item) => item.trim().length === 0)) {
    return err({ kind: "invalid_gate_toml", detail: `${label} must not contain empty strings` });
  }
  return ok(values);
};

const parseTriggerMap = (
  raw: unknown,
  label: string,
): Result<Readonly<Partial<Record<OneWayTrigger, readonly string[]>>>, OrchestratorConfigError> => {
  if (raw === undefined) return ok({});
  if (typeof raw !== "object" || raw === null) {
    return err({ kind: "invalid_gate_toml", detail: `${label} must be a table` });
  }

  const out: Partial<Record<OneWayTrigger, readonly string[]>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isOneWayTrigger(key)) {
      return err({ kind: "unknown_door_trigger", trigger: key });
    }
    const patterns = parseStringArray(value, `${label}.${key}`);
    if (!patterns.ok) {
      const detail =
        patterns.error.kind === "invalid_gate_toml"
          ? patterns.error.detail
          : `${label}.${key} invalid`;
      return err({
        kind: "invalid_door_patterns",
        trigger: key,
        detail,
      });
    }
    out[key] = patterns.value;
  }
  return ok(out);
};

interface ModelRefToml {
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly version?: unknown;
}

interface TierTableToml {
  readonly light?: unknown;
  readonly mid?: unknown;
  readonly heavy?: unknown;
}

interface BudgetToml {
  readonly rolling_window_tokens?: unknown;
  readonly session_tokens?: unknown;
  readonly per_change_tokens?: unknown;
  readonly kill_switch_tokens?: unknown;
  readonly persist?: unknown;
}

interface DoorTomlSection {
  readonly paths?: unknown;
  readonly tags?: unknown;
}

const parseModelRef = (raw: unknown, tier: string): Result<ModelRef, OrchestratorConfigError> => {
  if (typeof raw !== "object" || raw === null) {
    return err({ kind: "invalid_tier", tier, detail: "tier entry must be a table" });
  }
  const table = raw as ModelRefToml;
  const provider = table.provider;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return err({ kind: "invalid_tier", tier, detail: "provider must be a non-empty string" });
  }
  const model = table.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    return err({ kind: "invalid_tier", tier, detail: "model must be a non-empty string" });
  }
  const versionRaw = table.version;
  const version =
    versionRaw === undefined
      ? undefined
      : typeof versionRaw === "string" && versionRaw.trim().length > 0
        ? versionRaw
        : undefined;
  if (versionRaw !== undefined && version === undefined) {
    return err({
      kind: "invalid_tier",
      tier,
      detail: "version must be a non-empty string when set",
    });
  }
  return ok({
    provider,
    model,
    ...(version === undefined ? {} : { version }),
  });
};

const resolveTier = (
  raw: unknown | undefined,
  fallback: ModelRef,
  tier: string,
): Result<ModelRef, OrchestratorConfigError> => {
  if (raw === undefined) return ok(fallback);
  return parseModelRef(raw, tier);
};

const parseTierTable = (raw: unknown): Result<TierTable, OrchestratorConfigError> => {
  const defaults = defaultOrchestratorConfig().tiers;
  if (raw === undefined) return ok(defaults);

  if (typeof raw !== "object" || raw === null) {
    return err({ kind: "invalid_gate_toml", detail: "[tiers] must be a table" });
  }

  const table = raw as TierTableToml;
  const light = resolveTier(table.light, defaults.light, "light");
  if (!light.ok) return light;
  const mid = resolveTier(table.mid, defaults.mid, "mid");
  if (!mid.ok) return mid;
  const heavy = resolveTier(table.heavy, defaults.heavy, "heavy");
  if (!heavy.ok) return heavy;

  return ok({ light: light.value, mid: mid.value, heavy: heavy.value });
};

const resolveBudgetField = (
  raw: unknown | undefined,
  fallback: number,
  field: string,
): Result<number, OrchestratorConfigError> => {
  if (raw === undefined) return ok(fallback);
  return parsePositiveInt(raw, field);
};

const parsePositiveInt = (raw: unknown, field: string): Result<number, OrchestratorConfigError> => {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return err({ kind: "invalid_budget", detail: `${field} must be a positive integer` });
  }
  return ok(raw);
};

const parseBudget = (raw: unknown): Result<BudgetLimits, OrchestratorConfigError> => {
  const defaults = defaultOrchestratorConfig().budget;
  if (raw === undefined) return ok(defaults);

  if (typeof raw !== "object" || raw === null) {
    return err({ kind: "invalid_gate_toml", detail: "[budget] must be a table" });
  }

  const table = raw as BudgetToml;
  const rolling = resolveBudgetField(
    table.rolling_window_tokens,
    defaults.rollingWindowTokens,
    "rolling_window_tokens",
  );
  if (!rolling.ok) return rolling;
  const session = resolveBudgetField(
    table.session_tokens,
    defaults.sessionTokens,
    "session_tokens",
  );
  if (!session.ok) return session;
  const perChange = resolveBudgetField(
    table.per_change_tokens,
    defaults.perChangeTokens,
    "per_change_tokens",
  );
  if (!perChange.ok) return perChange;
  const killSwitch = resolveBudgetField(
    table.kill_switch_tokens,
    defaults.killSwitchTokens,
    "kill_switch_tokens",
  );
  if (!killSwitch.ok) return killSwitch;

  const persist = table.persist === undefined ? defaults.persist : table.persist === true;

  return ok({
    rollingWindowTokens: rolling.value,
    sessionTokens: session.value,
    perChangeTokens: perChange.value,
    killSwitchTokens: killSwitch.value,
    persist,
  });
};

const parseHitl = (raw: unknown): Result<HitlConfig, OrchestratorConfigError> => {
  const defaults = defaultOrchestratorConfig().hitl;
  if (raw === undefined) return ok(defaults);
  if (typeof raw !== "object" || raw === null) {
    return err({ kind: "invalid_gate_toml", detail: "[hitl] must be a table" });
  }
  const rate = (raw as { two_way_sample_rate?: unknown }).two_way_sample_rate;
  if (rate === undefined) return ok(defaults);
  if (typeof rate !== "number" || rate < 0 || rate > 1) {
    return err({ kind: "invalid_gate_toml", detail: "[hitl].two_way_sample_rate must be 0..1" });
  }
  return ok({ twoWaySampleRate: rate });
};

const parseRollout = (raw: unknown): Result<RolloutConfig, OrchestratorConfigError> => {
  const defaults = defaultOrchestratorConfig().rollout;
  if (raw === undefined) return ok(defaults);
  if (typeof raw !== "object" || raw === null) {
    return err({ kind: "invalid_gate_toml", detail: "[rollout] must be a table" });
  }
  const table = raw as {
    enabled?: unknown;
    adapter?: unknown;
    flag_name?: unknown;
    metric_ref?: unknown;
    threshold?: unknown;
    poll_interval_ms?: unknown;
    webhook_base_url?: unknown;
  };
  const enabled = table.enabled === undefined ? defaults.enabled : table.enabled === true;
  const adapterRaw = table.adapter;
  let adapter: RolloutAdapter;
  if (adapterRaw === "live") {
    adapter = "live";
  } else if (adapterRaw === undefined || adapterRaw === "injected") {
    adapter = "injected";
  } else {
    return err({ kind: "invalid_gate_toml", detail: "[rollout].adapter must be injected or live" });
  }
  const webhookBaseUrl =
    typeof table.webhook_base_url === "string" ? table.webhook_base_url : defaults.webhookBaseUrl;
  if (adapter === "live" && webhookBaseUrl.length === 0) {
    return err({
      kind: "invalid_gate_toml",
      detail: "[rollout].webhook_base_url required when adapter = live",
    });
  }
  const flagName =
    typeof table.flag_name === "string" && table.flag_name.length > 0
      ? table.flag_name
      : defaults.flagName;
  const metricRef =
    typeof table.metric_ref === "string" && table.metric_ref.length > 0
      ? table.metric_ref
      : defaults.metricRef;
  const threshold =
    typeof table.threshold === "number" && table.threshold >= 0
      ? table.threshold
      : table.threshold === undefined
        ? defaults.threshold
        : null;
  if (threshold === null) {
    return err({ kind: "invalid_gate_toml", detail: "[rollout].threshold must be >= 0" });
  }
  const pollIntervalMs =
    typeof table.poll_interval_ms === "number" && table.poll_interval_ms > 0
      ? table.poll_interval_ms
      : table.poll_interval_ms === undefined
        ? defaults.pollIntervalMs
        : null;
  if (pollIntervalMs === null) {
    return err({
      kind: "invalid_gate_toml",
      detail: "[rollout].poll_interval_ms must be a positive number",
    });
  }
  return ok({ enabled, adapter, flagName, metricRef, threshold, pollIntervalMs, webhookBaseUrl });
};

interface OrchestratorTomlSections {
  readonly door?: unknown;
  readonly tiers?: unknown;
  readonly budget?: unknown;
  readonly hitl?: unknown;
  readonly rollout?: unknown;
  readonly governance?: unknown;
}

export const defaultOrchestratorConfig = (): OrchestratorConfig => ({
  door: { pathPatterns: {}, tagPatterns: {} },
  tiers: {
    light: { provider: "faux", model: "light" },
    mid: { provider: "faux", model: "mid" },
    heavy: { provider: "faux", model: "heavy" },
  },
  budget: {
    rollingWindowTokens: 1_000_000,
    sessionTokens: 100_000,
    perChangeTokens: 50_000,
    killSwitchTokens: 500_000,
    persist: false,
  },
  hitl: { twoWaySampleRate: 0 },
  rollout: {
    enabled: false,
    adapter: "injected",
    flagName: "",
    metricRef: "",
    threshold: 0,
    pollIntervalMs: 60_000,
    webhookBaseUrl: "",
  },
  governance: defaultGovernancePolicy(),
});

/** Parse orchestrator sections from gate.toml text — fail-closed, no partial config. */
export const parseOrchestratorToml = (
  raw: string,
): Result<OrchestratorConfig, OrchestratorConfigError> => {
  let parsed: OrchestratorTomlSections;
  try {
    parsed = TOML.parse(raw) as OrchestratorTomlSections;
  } catch (error) {
    return err({
      kind: "invalid_gate_toml",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const doorTable =
    parsed.door === undefined
      ? ({} as DoorTomlSection)
      : typeof parsed.door === "object" && parsed.door !== null
        ? (parsed.door as DoorTomlSection)
        : null;
  if (doorTable === null) {
    return err({ kind: "invalid_gate_toml", detail: "[door] must be a table" });
  }

  const pathSource =
    doorTable.paths ??
    (parsed.door === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(parsed.door as Record<string, unknown>).filter(
            ([key]) => key !== "tags" && key !== "paths",
          ),
        ));
  const pathPatterns = parseTriggerMap(pathSource, "door.paths");
  if (!pathPatterns.ok) return pathPatterns;
  const tagPatterns = parseTriggerMap(doorTable.tags, "door.tags");
  if (!tagPatterns.ok) return tagPatterns;

  const tiers = parseTierTable(parsed.tiers);
  if (!tiers.ok) return tiers;

  const budget = parseBudget(parsed.budget);
  if (!budget.ok) return budget;

  const hitl = parseHitl(parsed.hitl);
  if (!hitl.ok) return hitl;

  const rollout = parseRollout(parsed.rollout);
  if (!rollout.ok) return rollout;

  const governance = parseGovernanceSection(parsed.governance);
  if (!governance.ok) {
    return err({ kind: "invalid_gate_toml", detail: governance.error.detail });
  }

  return ok({
    door: { pathPatterns: pathPatterns.value, tagPatterns: tagPatterns.value },
    tiers: tiers.value,
    budget: budget.value,
    hitl: hitl.value,
    rollout: rollout.value,
    governance: governance.value,
  });
};

/** Load orchestrator config from `.snaffle/gate.toml`; absent file → defaults. */
export const loadOrchestratorConfig = (
  worktreeRoot: string,
): Result<OrchestratorConfig, OrchestratorConfigError> => {
  const tomlPath = join(worktreeRoot, DEFAULT_GATE_CONFIG_REL);
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return parseOrchestratorToml(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return ok(defaultOrchestratorConfig());
    }
    return err({
      kind: "invalid_gate_toml",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
