import type { AgentKind } from "../domain/agent";
import type { ModelTier } from "./orchestrator-config";
import type { SkillName } from "./skills";

/**
 * The five real subagents (D3) — they exist only where stochasticity is
 * irreducible; there is no validator and no commit agent. Each definition is
 * pure data: the model tier (resolved provider-neutrally via config, D18), the
 * flat skills it composes (D2), and the write-scope *policy* the spine uses to
 * derive its capability grant (D6). Skills are loaded only from `src/skills/`
 * per this list — never from `.pi/skills`, `AGENTS.md`, or Pi env discovery.
 * The `stub` kind is the Phase-1 stand-in and has no definition here.
 */

export type RealAgentKind = Exclude<AgentKind, "stub">;

/** How the spine derives an agent's write scope from the lineage (D6). */
export type AgentScopePolicy =
  | "declared" // the lineage's declared scope (minus any frozen oracle)
  | "throwaway" // a scratch scope; output never merges as the change (spiker)
  | "frozen_tests_only"; // only the frozen-test paths (test author, D7)

export interface AgentDefinition {
  readonly kind: RealAgentKind;
  readonly tier: ModelTier;
  readonly skills: readonly SkillName[];
  readonly scopePolicy: AgentScopePolicy;
}

/**
 * Default tier assignment — spec is heavy (the spec spends the most model
 * budget per the architecture); the rest default lower. All are config-
 * overridable (D18): the tier name maps to a provider/model in project config.
 */
export const AGENT_DEFINITIONS: Readonly<Record<RealAgentKind, AgentDefinition>> = {
  spec: { kind: "spec", tier: "heavy", skills: ["spec-authoring"], scopePolicy: "declared" },
  planner: { kind: "planner", tier: "mid", skills: ["planning"], scopePolicy: "declared" },
  spiker: { kind: "spiker", tier: "light", skills: [], scopePolicy: "throwaway" },
  implementer: {
    kind: "implementer",
    tier: "mid",
    skills: ["implementation"],
    scopePolicy: "declared",
  },
  test_author: {
    kind: "test_author",
    tier: "mid",
    skills: ["test-authoring"],
    scopePolicy: "frozen_tests_only",
  },
};

export const agentDefinition = (kind: RealAgentKind): AgentDefinition => AGENT_DEFINITIONS[kind];
