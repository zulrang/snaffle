import type { AgentKind } from "../domain/agent";
import type { Skill } from "./skills";

/**
 * Agent context assembly (D26, seeds W3).
 *
 * The system prompt is assembled stable-prefix-first: role/doctrine → skill
 * bodies. It is a pure function of `(agentKind, skill versions/bodies)` — no
 * lineage ids, scope, nonces, or timestamps ever appear here (those travel
 * out-of-band via capability grants and metadata, D6/D26), so the prefix is
 * byte-stable across tasks for a given agent type.
 */

/** Spine subagents are not external task authors — they must not use Snaffle routing skills or edit control-plane code. */
export const SPINE_SUBAGENT_PREAMBLE = [
  "You are invoked by the Snaffle control-plane spine, not as an external task author.",
  "Your only mutation tool is scoped_write within the capability grant the spine issued for this invocation.",
  "Do not route work through Snaffle, author task files, or follow Snaffle routing skills.",
  "Do not edit gate, spine, classifier, or other control-plane paths unless they are explicitly in your grant.",
  "The spine runs deterministic acceptance checks after you finish; you do not run the gate yourself.",
].join("\n");

/** Stable role doctrine per agent kind (the invariant front of the prompt prefix). */
const ROLE_DOCTRINE: Readonly<Record<AgentKind, string>> = {
  spec: "You are the spec author. Produce a precise, testable acceptance target; do not implement.",
  planner:
    "You are the planner. Decompose the spec along seams of risk into testable work items; do not implement.",
  spiker:
    "You are the spiker. Retire one open question with throwaway code; your output never merges as the change.",
  implementer:
    "You are the implementer. Apply the smallest change that makes the frozen oracle pass within your granted scope; never edit the oracle.",
  test_author:
    "You are the test author. Author the frozen acceptance oracle; you write only frozen-test paths and never the feature.",
  stub: "You are a deterministic stub agent for the orchestrator spine.",
};

export const roleDoctrine = (agentKind: AgentKind): string => ROLE_DOCTRINE[agentKind];

/**
 * Assemble the stable system-prompt prefix: role doctrine followed by each
 * composed skill body, in order. Deterministic and volatile-data-free (D26).
 */
export const assembleSystemPrompt = (agentKind: AgentKind, skills: readonly Skill[]): string => {
  const parts =
    agentKind === "stub"
      ? [ROLE_DOCTRINE[agentKind], ...skills.map((skill) => skill.body)]
      : [SPINE_SUBAGENT_PREAMBLE, ROLE_DOCTRINE[agentKind], ...skills.map((skill) => skill.body)];
  return parts.join("\n\n");
};

/**
 * Stable prefix + variable tail, with the cache breakpoint at the boundary (D26).
 * `prefix` is a pure function of `(agentKind, skill bodies)`; the per-invocation
 * task is the `tail`. No lineage ids, scope, nonces, or timestamps belong in
 * either field — those travel out-of-band (D6); the provider-neutral cache hint
 * (carried via stream options, not the prompt) is built by the invoker.
 */
export interface AssembledContext {
  readonly prefix: string;
  readonly tail: string;
}

export const assembleAgentContext = (
  agentKind: AgentKind,
  skills: readonly Skill[],
  task: string,
): AssembledContext => ({
  prefix: assembleSystemPrompt(agentKind, skills),
  tail: task,
});
