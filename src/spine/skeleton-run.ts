import { join } from "node:path";
import { isScopeCompliant } from "../domain/agent";
import type { GateReport } from "../domain/gate";
import { gatePassed } from "../domain/gate";
import type { GateRunId, GenerationId, GrantId, InvocationId, TransitionId } from "../domain/ids";
import type { Lineage } from "../domain/lineage";
import { parseRepoPath } from "../domain/scope";
import { err, ok, parseTimestamp, type Result, type Timestamp } from "../domain/shared";
import type { LineageState, StateTransition } from "../domain/transition";
import { issueCapabilityGrant } from "../lib/capability-grant";
import { acquireWriterLock, type WriterLock } from "../lib/ownership-lock";
import {
  openProvenanceStore,
  PROVENANCE_DB_DIR,
  PROVENANCE_DB_FILE,
} from "../lib/provenance-store";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { applyScopeRefusalHold } from "../lib/transition-derivation";
import { validateAgentResult } from "../lib/validate-agent-result";
import { applyWritesToWorktree } from "../lib/worktree-writes";
import { reviewLineageTransition } from "./control-plane-transition";
import {
  type PreparedWorktreeGate,
  prepareWorktreeGate,
  runPostGateInWorktree,
  runPreGateInWorktree,
} from "./gate-invocation";
import { logStubGeneration } from "./provenance-invocation";
import {
  invokeWithCapabilityGrant,
  type ScopedWriteAttempt,
  type ScopeEvent,
} from "./scoped-invocation";

/**
 * W8 — end-to-end walking skeleton (W2–W7).
 *
 * One command drives lock → scoped stub agent → worktree apply → PRE/POST gate →
 * control-plane transition → provenance → release for a single lineage.
 */

export type SkeletonVariant = "merge_success" | "scope_blocked" | "post_gate_rejected";

export interface SkeletonRunIds {
  readonly grantId: GrantId;
  readonly invocationId: InvocationId;
  readonly generationId: GenerationId;
  readonly preGateRunId: GateRunId;
  readonly postGateRunId: GateRunId;
  readonly transitionId: TransitionId;
}

export interface SkeletonRunInput {
  readonly repoRoot: string;
  readonly lineage: Lineage;
  readonly variant: SkeletonVariant;
  readonly ids: SkeletonRunIds;
  readonly ownerId?: string;
  readonly at?: Timestamp;
}

export type SkeletonRunError =
  | { readonly kind: "workspace_lock"; readonly detail: string }
  | { readonly kind: "worktree_prepare"; readonly detail: string }
  | { readonly kind: "pre_gate_blocked"; readonly detail: string }
  | { readonly kind: "agent_invoke"; readonly detail: string }
  | { readonly kind: "agent_result_invalid"; readonly detail: string }
  | { readonly kind: "provenance"; readonly detail: string }
  | { readonly kind: "transition"; readonly detail: string }
  | { readonly kind: "worktree_apply"; readonly detail: string }
  | { readonly kind: "unexpected_variant_outcome"; readonly detail: string };

export type SkeletonRunOutcome =
  | {
      readonly kind: "merged";
      readonly finalState: Extract<LineageState, { readonly status: "merged" }>;
      readonly transition: StateTransition;
      readonly generationId: GenerationId;
      readonly postGate: GateReport;
    }
  | {
      readonly kind: "scope_blocked";
      readonly finalState: LineageState;
      readonly scopeEvents: readonly ScopeEvent[];
      readonly generationId: GenerationId;
    }
  | {
      readonly kind: "post_gate_rejected";
      readonly finalState: LineageState;
      readonly postGate: GateReport;
      readonly generationId: GenerationId;
    };

const runningState = { status: "running" as const, phase: "implement" as const };

const variantTask = (
  variant: SkeletonVariant,
): { readonly prompt: string; readonly writes: readonly ScopedWriteAttempt[] } => {
  switch (variant) {
    case "merge_success":
      return {
        prompt: "Apply a trivial in-scope marker file.",
        writes: [{ path: "src/lib/w8-marker.ts", content: "// w8 skeleton merge\n" }],
      };
    case "scope_blocked":
      return {
        prompt: "Attempt one in-scope and one out-of-scope write.",
        writes: [
          { path: "src/domain/allowed.ts", content: "// in scope\n" },
          { path: "src/secrets/forbidden.ts", content: "// out of scope\n" },
        ],
      };
    case "post_gate_rejected":
      return {
        prompt: "Apply a change that breaks the gate fixture.",
        writes: [
          {
            path: "src/lib/w8-gate-fixture.test.ts",
            content: [
              'import { describe, expect, test } from "bun:test";',
              'describe("w8 gate fixture", () => {',
              '  test("fails post-apply", () => { expect(1).toBe(2); });',
              "});",
              "",
            ].join("\n"),
          },
        ],
      };
  }
};

const contentForEdit = (
  writes: readonly ScopedWriteAttempt[],
  agentResult: { readonly edits: readonly { readonly path: string }[] },
): Result<
  readonly { readonly path: string; readonly content: string }[],
  { readonly detail: string }
> => {
  const byRepoPath = new Map<string, string>();
  for (const write of writes) {
    const parsed = parseRepoPath(write.path);
    if (!parsed.ok) return err({ detail: write.path });
    byRepoPath.set(parsed.value, write.content);
  }

  const applied: { path: string; content: string }[] = [];
  for (const edit of agentResult.edits) {
    const content = byRepoPath.get(edit.path);
    if (content === undefined) {
      return err({ detail: `no spine content for edit path ${edit.path}` });
    }
    applied.push({ path: edit.path, content });
  }

  return ok(applied);
};

const releaseLock = async (lock: WriterLock | undefined): Promise<void> => {
  if (lock) await lock.release();
};

/** Run the Phase 1 walking skeleton for one lineage variant. */
export const runSkeletonLineage = async (
  input: SkeletonRunInput,
): Promise<Result<SkeletonRunOutcome, SkeletonRunError>> => {
  const at = input.at === undefined ? parseTimestamp(Date.now()) : parseTimestamp(input.at);
  if (!at.ok) {
    return err({ kind: "unexpected_variant_outcome", detail: "invalid timestamp" });
  }

  const task = variantTask(input.variant);
  const provenancePath = join(input.repoRoot, PROVENANCE_DB_DIR, PROVENANCE_DB_FILE);
  const store = openProvenanceStore(provenancePath);

  let lock: WriterLock | undefined;
  let prepared: PreparedWorktreeGate | undefined;

  try {
    const locked = await acquireWriterLock(
      input.ownerId === undefined
        ? { workspaceRoot: input.repoRoot }
        : { workspaceRoot: input.repoRoot, ownerId: input.ownerId },
    );
    if (!locked.ok) {
      return err({ kind: "workspace_lock", detail: locked.error.kind });
    }
    lock = locked.value;

    const worktree = await prepareWorktreeGate(input.repoRoot);
    if (!worktree.ok) {
      return err({ kind: "worktree_prepare", detail: worktree.error.kind });
    }
    prepared = worktree.value;

    writePassingGateFixture(prepared.worktreeRoot);
    const gateContext = {
      worktreeRoot: prepared.worktreeRoot,
      config: skeletonGateConfig(),
    };

    const pre = await runPreGateInWorktree(gateContext, {
      gateRunId: input.ids.preGateRunId,
      lineageId: input.lineage.lineageId,
    });
    if (!pre.ok) {
      return err({ kind: "pre_gate_blocked", detail: pre.error.kind });
    }

    const grant = issueCapabilityGrant({
      grantId: input.ids.grantId,
      lineageId: input.lineage.lineageId,
      invocationId: input.ids.invocationId,
      scope: input.lineage.declaredScope,
      issuedAt: at.value,
    });
    if (!grant.ok) {
      return err({ kind: "agent_invoke", detail: grant.error.kind });
    }

    const invoked = await invokeWithCapabilityGrant(grant.value, {
      invocationId: input.ids.invocationId,
      prompt: task.prompt,
      writes: task.writes,
    });
    if (!invoked.ok) {
      return err({ kind: "agent_invoke", detail: invoked.error.kind });
    }

    const logged = logStubGeneration(store, {
      generationId: input.ids.generationId,
      lineageId: input.lineage.lineageId,
      invocationId: input.ids.invocationId,
      prompt: task.prompt,
      writes: task.writes,
      metadata: invoked.value.metadata,
      scope: grant.value.scope,
      agentResult: invoked.value.agentResult,
      recordedAt: at.value,
    });
    if (!logged.ok) {
      return err({ kind: "provenance", detail: logged.error.kind });
    }

    if (input.variant === "scope_blocked") {
      const denied = invoked.value.scopeEvents.some((event) => event.kind === "write_denied");
      if (!denied) {
        return err({ kind: "unexpected_variant_outcome", detail: "expected scope denial" });
      }

      const scopeHold = applyScopeRefusalHold(runningState);
      if (scopeHold.kind !== "no_transition") {
        return err({ kind: "transition", detail: "expected scope refusal hold" });
      }
      if (scopeHold.outcome.kind !== "hold" || scopeHold.outcome.reason !== "agent_refused") {
        return err({ kind: "transition", detail: "expected agent_refused hold outcome" });
      }

      return ok({
        kind: "scope_blocked",
        finalState: scopeHold.state,
        scopeEvents: invoked.value.scopeEvents,
        generationId: input.ids.generationId,
      });
    }

    const validated = validateAgentResult(invoked.value.agentResult, input.ids.invocationId);
    if (!validated.ok) {
      return err({ kind: "agent_result_invalid", detail: validated.error.reason });
    }

    if (!isScopeCompliant(validated.value, grant.value.scope)) {
      return err({
        kind: "agent_result_invalid",
        detail: "agent result edits outside granted scope",
      });
    }

    const toApply = contentForEdit(task.writes, validated.value);
    if (!toApply.ok) {
      return err({ kind: "worktree_apply", detail: toApply.error.detail });
    }

    const applied = applyWritesToWorktree(prepared.worktreeRoot, toApply.value);
    if (!applied.ok) {
      return err({ kind: "worktree_apply", detail: applied.error.kind });
    }

    const postGate = await runPostGateInWorktree(gateContext, {
      gateRunId: input.ids.postGateRunId,
      lineageId: input.lineage.lineageId,
    });

    const reviewed = reviewLineageTransition({
      lineage: input.lineage,
      currentState: runningState,
      evidence: {
        door: input.lineage.door,
        agentResult: validated.value,
        postGateReport: postGate,
        grantedScope: grant.value.scope,
      },
      transitionId: input.ids.transitionId,
      at: at.value,
    });
    if (!reviewed.ok) {
      return err({ kind: "transition", detail: reviewed.error.kind });
    }

    if (input.variant === "merge_success") {
      if (reviewed.value.kind !== "transition_applied") {
        return err({ kind: "unexpected_variant_outcome", detail: "expected merge transition" });
      }
      if (reviewed.value.newState.status !== "merged") {
        return err({ kind: "unexpected_variant_outcome", detail: "expected merged state" });
      }
      if (!gatePassed(postGate)) {
        return err({ kind: "unexpected_variant_outcome", detail: "expected green POST-gate" });
      }

      return ok({
        kind: "merged",
        finalState: reviewed.value.newState,
        transition: reviewed.value.transition,
        generationId: input.ids.generationId,
        postGate,
      });
    }

    if (input.variant === "post_gate_rejected") {
      if (gatePassed(postGate)) {
        return err({ kind: "unexpected_variant_outcome", detail: "expected red POST-gate" });
      }
      if (reviewed.value.kind !== "no_transition") {
        return err({
          kind: "unexpected_variant_outcome",
          detail: "expected hold without transition",
        });
      }

      return ok({
        kind: "post_gate_rejected",
        finalState: reviewed.value.state,
        postGate,
        generationId: input.ids.generationId,
      });
    }

    return err({
      kind: "unexpected_variant_outcome",
      detail: `unhandled variant ${input.variant}`,
    });
  } finally {
    try {
      store.close();
    } catch {
      // ignore close errors
    }
    if (prepared) {
      try {
        await prepared.dispose();
      } catch {
        // ponytail: still release lock when worktree teardown fails
      }
    }
    await releaseLock(lock);
  }
};
