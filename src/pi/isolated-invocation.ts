/**
 * Spine Pi invocations use headless `pi-agent-core` Agent — never
 * `pi-coding-agent`'s `DefaultResourceLoader` / `createAgentSession`, which
 * would discover `.pi/skills`, `AGENTS.md`, and other environment resources.
 * Skills are composed explicitly by the spine (`lib/skills` → `agent-context`)
 * and inlined into `systemPrompt` before the Agent is constructed.
 */

/** The only tool spine subagents receive (D6). */
export const SPINE_AGENT_TOOL_NAMES = ["scoped_write"] as const;

export interface ExplicitSkillRef {
  readonly name: string;
  readonly version: string;
}

/** Markers that indicate Pi on-demand / environment skill discovery leaked in. */
const FORBIDDEN_SKILL_MARKERS = ["<available_skills>", ".pi/skills", ".cursor/skills"] as const;

/** Fail fast if the composed prompt picked up environment skill discovery (D2/D26). */
export const assertIsolatedSystemPrompt = (systemPrompt: string): void => {
  for (const marker of FORBIDDEN_SKILL_MARKERS) {
    if (systemPrompt.includes(marker)) {
      throw new Error(
        `spine agent system prompt must not include environment skill marker: ${marker}`,
      );
    }
  }
};
