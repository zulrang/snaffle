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
export const assembleSystemPrompt = (agentKind: AgentKind, skills: readonly Skill[]): string =>
  [ROLE_DOCTRINE[agentKind], ...skills.map((skill) => skill.body)].join("\n\n");
