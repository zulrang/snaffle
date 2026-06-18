import { type AgentResult, isScopeCompliant } from "../domain/agent";
import type { FailureVerdict, RoutingAction } from "../domain/failure";
import { type GateReport, gatePassed } from "../domain/gate";
import type { DecisionId, GateRunId, InvocationId, TransitionId } from "../domain/ids";
import { InvocationId as makeInvocationId } from "../domain/ids";
import type { Lineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { err, ok, type Result, type Timestamp } from "../domain/shared";
import type { LineageState, StateTransition } from "../domain/transition";
import { AGENT_DEFINITIONS } from "../lib/agents";
import type { BudgetGovernorState } from "../lib/budget-governor";
import { createBudgetGovernor } from "../lib/budget-governor";
import { type DecisionQueueStore, enqueueAwaitingHuman } from "../lib/decision-queue";
import {
  EXPAND_CONTRACT_PHASES,
  type ExpandContractPlan,
  emitExpandContractPlan,
} from "../lib/expand-contract";
import { classifyAndRoute } from "../lib/failure-classifier";
import {
  initialRouterState,
  type RouteFailureDecision,
  routeFailureWithPolicy,
} from "../lib/failure-router";
import type { OracleCoverageDecision } from "../lib/oracle-coverage";
import type { OracleFreezeRecord } from "../lib/oracle-freeze";
import type { OrchestratorConfig } from "../lib/orchestrator-config";
import { type PipelinePhase, type RegimePlan, selectRegimePlan } from "../lib/regime-plan";
import type { RolloutClient, RolloutGuardrailOutcome } from "../lib/rollout-guardrail";
import { detectStatefulChange } from "../lib/stateful-change";
import { shouldSampleTwoWayMerge, twoWaySampleRateFromConfig } from "../lib/two-way-sampler";
import { validateAgentResult } from "../lib/validate-agent-result";
import { applyWritesToWorktree } from "../lib/worktree-writes";
import type { PromptCacheHint } from "../pi/prompt-cache";
import { reviewLineageTransition } from "./control-plane-transition";
import type { WorktreeGateContext } from "./gate-invocation";
import { runPostGateInWorktree } from "./gate-invocation";
import { invokeAgent } from "./invoke-agent";
import { runOracleAuthoringPhase } from "./oracle-authoring";
import type { ScopedWriteAttempt, ScopeEvent } from "./scoped-invocation";
import { stepBudget } from "./skeleton-run";
import {
  dryRunRolloutClient,
  recordGateReportSpans,
  runPostMergeRolloutIfEnabled,
} from "./spine-wiring";

/**
 * W5 — phase pipeline runner (D §8, D19). Generalizes the Phase-1 single-shot
 * skeleton into a phase sequencer: spec → plan → (spike) → oracle → implement →
 * validate, driven by a regime plan (S4). Each agent phase is a composed
 * invocation (W2/W3); the oracle is frozen before implement (W4); the budget is
 * checked between phases (D22); and the terminal transition is derived in the
 * control plane (D19) — auto-merge for two-way, await-human for one-way. A red
 * validate gate is classified and routed (Phase-3 failure routing), never merged.
 */

const runningState: LineageState = { status: "running", phase: "implement" };

/**
 * Throwaway scratch scope for the spiker (W8, D25). The spike retires an open
 * question; its output is never the change, so it is confined to a scratch path
 * the runner never applies to the worktree — disjoint from any lineage scope.
 */
export const SPIKE_THROWAWAY_PATH = ".orchestrator/spike";

const spikeThrowawayScope = () => {
  const path = parseRepoPath(SPIKE_THROWAWAY_PATH);
  if (!path.ok) return undefined;
  const scope = makeWriteScope([path.value]);
  return scope.ok ? scope.value : undefined;
};

export interface PhaseTask {
  readonly prompt: string;
  readonly writes: readonly ScopedWriteAttempt[];
}

export interface PipelineIds {
  readonly invocationBase: string;
  readonly transitionId: TransitionId;
  readonly postGateRunId: GateRunId;
}

export interface LineagePipelineInput {
  readonly repoRoot: string;
  readonly gate: WorktreeGateContext;
  readonly lineage: Lineage;
  readonly plan: RegimePlan;
  readonly config: OrchestratorConfig;
  readonly tasks: Partial<Record<PipelinePhase, PhaseTask>>;
  readonly oraclePaths?: readonly string[];
  readonly ids: PipelineIds;
  readonly at: Timestamp;
  readonly frozenAt?: number;
  readonly cacheHint?: PromptCacheHint;
  /** When set, parks enqueue a durable human decision (W5/W9). */
  readonly decisionQueue?: DecisionQueueStore;
  readonly decisionId?: DecisionId;
  /** Present when W1 detects a stateful change (D9, W3). */
  readonly expandContractPlan?: ExpandContractPlan;
  /** Injected rollout client; defaults to dry-run when rollout is enabled (W5). */
  readonly rolloutClient?: RolloutClient;
}

export interface PipelinePhaseRecord {
  readonly phase: PipelinePhase;
  readonly agentKind?: string;
  readonly outcome: string;
}

export type PipelineTerminal =
  | {
      readonly kind: "merged";
      readonly transition: StateTransition;
      readonly postGate: GateReport;
      readonly rollout?: RolloutGuardrailOutcome;
    }
  | {
      readonly kind: "awaiting_human";
      readonly transition: StateTransition;
      readonly postGate: GateReport;
    }
  | {
      readonly kind: "failure_routed";
      readonly postGate: GateReport;
      readonly verdict: FailureVerdict;
      readonly action: RoutingAction;
      readonly routeDecision: RouteFailureDecision;
      readonly state: LineageState;
    }
  | { readonly kind: "implement_refused"; readonly scopeEvents: readonly ScopeEvent[] };

export interface LineagePipelineOutcome {
  readonly phases: readonly PipelinePhaseRecord[];
  readonly terminal: PipelineTerminal;
}

export type PipelineError =
  | { readonly kind: "invalid_id"; readonly detail: string }
  | { readonly kind: "agent_invoke"; readonly detail: string }
  | { readonly kind: "agent_result_invalid"; readonly detail: string }
  | { readonly kind: "scope_violation"; readonly detail: string }
  | { readonly kind: "oracle_authoring"; readonly detail: string }
  | { readonly kind: "worktree_apply"; readonly detail: string }
  | { readonly kind: "transition"; readonly detail: string }
  | { readonly kind: "budget_paused"; readonly detail: string }
  | { readonly kind: "missing_task"; readonly phase: PipelinePhase }
  | { readonly kind: "no_validate_phase"; readonly detail: string }
  | { readonly kind: "unexpected_terminal"; readonly detail: string };

const phaseInvocationId = (
  base: string,
  phase: PipelinePhase,
): Result<InvocationId, PipelineError> => {
  const id = makeInvocationId(`${base}-${phase}`);
  if (!id.ok) return err({ kind: "invalid_id", detail: `${base}-${phase}` });
  return ok(id.value);
};

const advanceBudget = (
  state: BudgetGovernorState,
  repoRoot: string,
  tokens: number,
): Result<BudgetGovernorState, PipelineError> => {
  const next = stepBudget(state, repoRoot, tokens);
  if (!next.ok) {
    return err({
      kind: "budget_paused",
      detail: next.error.kind === "budget_paused" ? next.error.detail : next.error.kind,
    });
  }
  return next;
};

const enqueueHumanDecision = (
  input: LineagePipelineInput,
  kind: "merge_hold" | "two_way_sample",
): void => {
  if (input.decisionQueue === undefined || input.decisionId === undefined) return;
  if (kind === "merge_hold") {
    enqueueAwaitingHuman(input.decisionQueue, {
      decisionId: input.decisionId,
      lineageId: input.lineage.lineageId,
      door: input.lineage.door,
      enqueuedAt: input.at,
    });
    return;
  }
  input.decisionQueue.enqueue({
    decisionId: input.decisionId,
    lineageId: input.lineage.lineageId,
    kind: "two_way_sample",
    door: input.lineage.door,
    enqueuedAt: input.at,
  });
};

const humanHoldTransition = (reviewed: StateTransition): StateTransition => ({
  ...reviewed,
  to: { status: "awaiting_human" },
});

const isExpandContractPhase = (phase: PipelinePhase): boolean =>
  (EXPAND_CONTRACT_PHASES as readonly string[]).includes(phase);

const finalizeMergedTerminal = async (
  input: LineagePipelineInput,
  phases: PipelinePhaseRecord[],
  transition: StateTransition,
  postGate: GateReport,
): Promise<Result<LineagePipelineOutcome, PipelineError>> => {
  const rollout = await runPostMergeRolloutIfEnabled(
    input.repoRoot,
    input.config,
    input.lineage.lineageId,
    input.rolloutClient ?? dryRunRolloutClient(),
  );

  return ok({
    phases,
    terminal: {
      kind: "merged",
      transition,
      postGate,
      ...(rollout === undefined ? {} : { rollout }),
    },
  });
};

/** Run a lineage through its regime's phase sequence to a control-plane terminal. */
export const runLineagePipeline = async (
  input: LineagePipelineInput,
): Promise<Result<LineagePipelineOutcome, PipelineError>> => {
  const phases: PipelinePhaseRecord[] = [];
  let budget = createBudgetGovernor();
  let oracleFreeze: OracleFreezeRecord | undefined;
  let implementResult: AgentResult | undefined;
  const frozenAt = input.frozenAt ?? 1;
  const cacheHint = input.cacheHint;

  for (const phase of input.plan.phases) {
    if (phase === "spec" || phase === "plan" || phase === "spike") {
      const def =
        phase === "spike"
          ? AGENT_DEFINITIONS.spiker
          : phase === "spec"
            ? AGENT_DEFINITIONS.spec
            : AGENT_DEFINITIONS.planner;
      const task = input.tasks[phase] ?? { prompt: `Run the ${phase} phase.`, writes: [] };
      const invocationId = phaseInvocationId(input.ids.invocationBase, phase);
      if (!invocationId.ok) return invocationId;

      // The spiker runs in a throwaway scratch scope (D25); spec/plan author
      // artifacts inside the lineage scope. None of these writes are applied.
      let phaseScope = input.lineage.declaredScope;
      if (phase === "spike") {
        const throwaway = spikeThrowawayScope();
        if (throwaway === undefined) {
          return err({ kind: "scope_violation", detail: "could not build spike throwaway scope" });
        }
        phaseScope = throwaway;
      }

      const invoked = await invokeAgent({
        definition: def,
        invocationId: invocationId.value,
        prompt: task.prompt,
        writes: task.writes,
        scope: phaseScope,
        config: input.config,
        repoRoot: input.repoRoot,
        workspaceRoot: input.gate.worktreeRoot,
        ...(cacheHint === undefined ? {} : { cacheHint }),
      });
      if (!invoked.ok) return err({ kind: "agent_invoke", detail: JSON.stringify(invoked.error) });

      // spec/plan/spike produce artifacts, not the merged change; the spiker is
      // throwaway by construction (D25) — none of their writes are applied here.
      phases.push({ phase, agentKind: def.kind, outcome: invoked.value.agentResult.outcome });

      const advanced = advanceBudget(
        budget,
        input.repoRoot,
        invoked.value.metadata.usage?.totalTokens ?? 0,
      );
      if (!advanced.ok) return advanced;
      budget = advanced.value;
      continue;
    }

    if (isExpandContractPhase(phase)) {
      if (input.expandContractPlan === undefined) {
        return err({ kind: "missing_task", phase });
      }
      const spec = input.expandContractPlan.phases.find((p) => p.phase === phase);
      if (spec === undefined) {
        return err({ kind: "missing_task", phase });
      }
      const applied = applyWritesToWorktree(input.gate.worktreeRoot, [
        {
          path: spec.artifactPath,
          content: `${JSON.stringify({ phase: spec.phase, doneWhen: spec.doneWhen }, null, 2)}\n`,
        },
      ]);
      if (!applied.ok) {
        return err({ kind: "worktree_apply", detail: JSON.stringify(applied.error) });
      }
      phases.push({ phase, outcome: "recorded" });
      continue;
    }

    if (phase === "oracle_authoring") {
      const task = input.tasks.oracle_authoring;
      if (task === undefined || input.oraclePaths === undefined) {
        return err({ kind: "missing_task", phase });
      }
      const invocationId = phaseInvocationId(input.ids.invocationBase, phase);
      if (!invocationId.ok) return invocationId;

      const authored = await runOracleAuthoringPhase({
        worktreeRoot: input.gate.worktreeRoot,
        invocationId: invocationId.value,
        oraclePaths: input.oraclePaths,
        oracleWrites: task.writes,
        config: input.config,
        repoRoot: input.repoRoot,
        frozenAt,
        prompt: task.prompt,
        ...(cacheHint === undefined ? {} : { cacheHint }),
      });
      if (!authored.ok) {
        return err({ kind: "oracle_authoring", detail: JSON.stringify(authored.error) });
      }
      oracleFreeze = authored.value.freeze;
      phases.push({ phase, agentKind: "test_author", outcome: authored.value.agentResult.outcome });

      const advanced = advanceBudget(budget, input.repoRoot, 0);
      if (!advanced.ok) return advanced;
      budget = advanced.value;
      continue;
    }

    if (phase === "implement") {
      const task = input.tasks.implement;
      if (task === undefined) return err({ kind: "missing_task", phase });
      const invocationId = phaseInvocationId(input.ids.invocationBase, phase);
      if (!invocationId.ok) return invocationId;

      const invoked = await invokeAgent({
        definition: AGENT_DEFINITIONS.implementer,
        invocationId: invocationId.value,
        prompt: task.prompt,
        writes: task.writes,
        scope: input.lineage.declaredScope,
        config: input.config,
        repoRoot: input.repoRoot,
        workspaceRoot: input.gate.worktreeRoot,
        ...(oracleFreeze === undefined ? {} : { oracleFreeze }),
        ...(cacheHint === undefined ? {} : { cacheHint }),
      });
      if (!invoked.ok) return err({ kind: "agent_invoke", detail: JSON.stringify(invoked.error) });

      const result = invoked.value.agentResult;
      phases.push({ phase, agentKind: "implementer", outcome: result.outcome });

      if (result.outcome !== "succeeded") {
        // The implementer refused (e.g. a frozen-oracle / out-of-scope write, D6/D7).
        return ok({
          phases,
          terminal: { kind: "implement_refused", scopeEvents: invoked.value.scopeEvents },
        });
      }

      const validated = validateAgentResult(result, invocationId.value);
      if (!validated.ok) {
        return err({ kind: "agent_result_invalid", detail: validated.error.reason });
      }
      if (!isScopeCompliant(validated.value, input.lineage.declaredScope)) {
        return err({ kind: "scope_violation", detail: "implementer edits outside granted scope" });
      }

      const applied = applyWritesToWorktree(
        input.gate.worktreeRoot,
        task.writes.map((write) => ({ path: write.path, content: write.content })),
      );
      if (!applied.ok)
        return err({ kind: "worktree_apply", detail: JSON.stringify(applied.error) });

      implementResult = validated.value;

      const advanced = advanceBudget(
        budget,
        input.repoRoot,
        invoked.value.metadata.usage?.totalTokens ?? 0,
      );
      if (!advanced.ok) return advanced;
      budget = advanced.value;
      continue;
    }

    // phase === "validate"
    if (implementResult === undefined) {
      return err({ kind: "unexpected_terminal", detail: "validate reached before implement" });
    }

    const postGate = await runPostGateInWorktree(input.gate, {
      gateRunId: input.ids.postGateRunId,
      lineageId: input.lineage.lineageId,
    });

    recordGateReportSpans(input.repoRoot, {
      gateRunId: input.ids.postGateRunId,
      lineageId: input.lineage.lineageId,
      startedAt: input.at,
      report: postGate,
    });

    const reviewed = reviewLineageTransition({
      lineage: input.lineage,
      currentState: runningState,
      evidence: {
        door: input.lineage.door,
        agentResult: implementResult,
        postGateReport: postGate,
        grantedScope: input.lineage.declaredScope,
      },
      transitionId: input.ids.transitionId,
      at: input.at,
    });
    if (!reviewed.ok) return err({ kind: "transition", detail: reviewed.error.kind });

    if (!gatePassed(postGate)) {
      // Failure routing fires between phases (Phase-3 classifier/router).
      const classified = classifyAndRoute({ kind: "gate_report", report: postGate });
      const routeDecision = routeFailureWithPolicy(classified.verdict, initialRouterState("light"));
      phases.push({ phase, outcome: "gate_red" });
      return ok({
        phases,
        terminal: {
          kind: "failure_routed",
          postGate,
          verdict: classified.verdict,
          action: classified.action,
          routeDecision,
          state: reviewed.value.kind === "no_transition" ? reviewed.value.state : runningState,
        },
      });
    }

    phases.push({ phase, outcome: "checked" });

    if (reviewed.value.kind === "transition_applied") {
      const status = reviewed.value.newState.status;
      if (status === "merged") {
        const sampleRate = twoWaySampleRateFromConfig(input.config);
        if (shouldSampleTwoWayMerge(input.lineage.lineageId, input.lineage.door, sampleRate)) {
          enqueueHumanDecision(input, "two_way_sample");
          return ok({
            phases,
            terminal: {
              kind: "awaiting_human",
              transition: humanHoldTransition(reviewed.value.transition),
              postGate,
            },
          });
        }
        return finalizeMergedTerminal(input, phases, reviewed.value.transition, postGate);
      }
      if (status === "awaiting_human") {
        enqueueHumanDecision(input, "merge_hold");
        return ok({
          phases,
          terminal: { kind: "awaiting_human", transition: reviewed.value.transition, postGate },
        });
      }
    }

    return err({
      kind: "unexpected_terminal",
      detail: `green validate did not derive merge/await-human (${reviewed.value.kind})`,
    });
  }

  return err({ kind: "no_validate_phase", detail: "plan has no validate phase" });
};

export interface RegimePipelineInput extends Omit<LineagePipelineInput, "plan"> {
  /** Oracle-reuse decision (W6); `reuse` collapses oracle-authoring in the minimal regime. */
  readonly coverage: OracleCoverageDecision;
  readonly hasOpenQuestion?: boolean;
  readonly rolloutClient?: RolloutClient;
}

/**
 * W6 entry point: derive the phase sequence from the lineage's regime + oracle
 * coverage, then run it. The runner never receives a hand-picked plan — the door
 * and coverage decide it (D25).
 */
export const runLineageForRegime = async (
  input: RegimePipelineInput,
): Promise<Result<LineagePipelineOutcome, PipelineError>> => {
  const statefulKind = detectStatefulChange({
    scope: input.lineage.declaredScope,
    door: input.lineage.door,
  });
  const expandPlan =
    statefulKind === "stateful"
      ? emitExpandContractPlan({
          lineageId: input.lineage.lineageId,
          statefulKind,
          frozenAt: input.at,
        })
      : undefined;
  if (expandPlan !== undefined && !expandPlan.ok) {
    return err({ kind: "unexpected_terminal", detail: expandPlan.error.kind });
  }

  const plan = selectRegimePlan(input.lineage.door, input.coverage, {
    ...(input.hasOpenQuestion === undefined ? {} : { hasOpenQuestion: input.hasOpenQuestion }),
    ...(statefulKind === "stateful" ? { stateful: true } : {}),
  });
  return runLineagePipeline({
    ...input,
    plan,
    ...(expandPlan?.ok ? { expandContractPlan: expandPlan.value } : {}),
    ...(input.rolloutClient === undefined ? {} : { rolloutClient: input.rolloutClient }),
  });
};
