import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyTwoWay } from "../domain/door";
import { DecisionId, GateRunId, LineageId, RequirementId, TransitionId } from "../domain/ids";
import { makeLineage } from "../domain/lineage";
import { makeWriteScope, parseRepoPath, type RepoPath } from "../domain/scope";
import { err, ok, parseTimestamp, type Result, type Timestamp } from "../domain/shared";
import { snapshotAcceptanceTarget } from "../lib/acceptance-snapshot";
import type { DecisionReviewContext } from "../lib/decision-queue";
import { DECISION_DB_DIR, DECISION_DB_FILE, openDecisionQueueStore } from "../lib/decision-queue";
import { type DogfoodTask, dogfoodTaskPrompt, parseDogfoodTask } from "../lib/dogfood-task";
import { classifyDoor } from "../lib/door-classifier";
import { type ProjectGateConfig, parseGateToml } from "../lib/gate-config";
import type { OrchestratorConfig } from "../lib/orchestrator-config";
import {
  defaultOrchestratorConfig,
  loadOrchestratorConfig,
  parseOrchestratorToml,
} from "../lib/orchestrator-config";
import { skeletonGateConfig, writePassingGateFixture } from "../lib/skeleton-gate-fixture";
import { prepareWorktreeGate } from "./gate-invocation";
import type { PhaseTask } from "./phase-pipeline";
import { type LineagePipelineOutcome, runLineageForRegime } from "./phase-pipeline";

/**
 * W8 — default regime pipeline entry (replaces skeleton as the default `run`).
 */

export type RegimeRunError =
  | { readonly kind: "invalid_default" }
  | { readonly kind: "task_read"; readonly detail: string }
  | { readonly kind: "task_invalid"; readonly detail: string }
  | { readonly kind: "config_read"; readonly detail: string }
  | { readonly kind: "config_invalid"; readonly detail: string }
  | { readonly kind: "worktree_prepare"; readonly detail: string }
  | { readonly kind: "pipeline"; readonly detail: string };

export interface RegimeRunInput {
  readonly repoRoot: string;
  readonly taskFile?: string;
  readonly configFile?: string;
}

interface RegimeRunSpec {
  readonly lineage: ReturnType<typeof makeLineage>;
  readonly coverage: { readonly kind: "reuse"; readonly coveredCriteria: readonly string[] };
  readonly tasks: Partial<Record<"spec" | "plan" | "oracle_authoring" | "implement", PhaseTask>>;
  readonly oraclePaths?: readonly string[];
  readonly decisionReview: DecisionReviewContext;
  readonly ids: {
    readonly invocationBase: string;
    readonly decisionId: DecisionId;
    readonly transitionId: TransitionId;
    readonly postGateRunId: GateRunId;
  };
}

const buildDefaultRunSpec = (ts: Timestamp): Result<RegimeRunSpec, RegimeRunError> => {
  const domainPath = parseRepoPath("src/domain");
  const libPath = parseRepoPath("src/lib");
  if (!domainPath.ok || !libPath.ok) return err({ kind: "invalid_default" });

  const scope = makeWriteScope([domainPath.value, libPath.value]);
  if (!scope.ok) return err({ kind: "invalid_default" });

  const lineageId = LineageId("lineage-regime-default");
  const requirementId = RequirementId("req-regime-default");
  const decisionId = DecisionId("dec-regime-default");
  const transitionId = TransitionId("tr-regime-default");
  const postGateRunId = GateRunId("gate-regime-default-post");
  if (
    !lineageId.ok ||
    !requirementId.ok ||
    !decisionId.ok ||
    !transitionId.ok ||
    !postGateRunId.ok
  ) {
    return err({ kind: "invalid_default" });
  }

  const acceptanceTarget = snapshotAcceptanceTarget({
    criteria: [{ id: "c1", statement: "regime pipeline merges on green POST-gate" }],
    frozenAt: ts,
  });
  if (!acceptanceTarget.ok) return err({ kind: "invalid_default" });

  return ok({
    lineage: makeLineage({
      lineageId: lineageId.value,
      requirementId: requirementId.value,
      door: classifyTwoWay(),
      acceptanceTarget: acceptanceTarget.value,
      declaredScope: scope.value,
      createdAt: ts,
    }),
    coverage: { kind: "reuse", coveredCriteria: ["c1"] },
    tasks: {
      implement: {
        prompt: "Apply a trivial in-scope marker file.",
        writes: [{ path: "src/lib/regime-marker.ts", content: "// regime default run\n" }],
      },
    },
    decisionReview: {
      summary: "Apply a trivial in-scope marker file.",
      scope: ["src/domain", "src/lib"],
      acceptanceCriteria: ["regime pipeline merges on green POST-gate"],
    },
    ids: {
      invocationBase: "inv-regime-default",
      decisionId: decisionId.value,
      transitionId: transitionId.value,
      postGateRunId: postGateRunId.value,
    },
  });
};

const loadTaskFile = (repoRoot: string, taskFile: string): Result<DogfoodTask, RegimeRunError> => {
  try {
    const raw = readFileSync(resolve(repoRoot, taskFile), "utf8");
    const parsed = parseDogfoodTask(raw);
    if (!parsed.ok) return err({ kind: "task_invalid", detail: parsed.error.detail });
    return ok(parsed.value);
  } catch (error) {
    return err({
      kind: "task_read",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

const loadRunConfig = (
  repoRoot: string,
  configFile: string | undefined,
): Result<OrchestratorConfig, RegimeRunError> => {
  if (configFile === undefined) {
    const loadedConfig = loadOrchestratorConfig(repoRoot);
    return loadedConfig.ok ? ok(loadedConfig.value) : ok(defaultOrchestratorConfig());
  }

  try {
    const raw = readFileSync(resolve(repoRoot, configFile), "utf8");
    const parsed = parseOrchestratorToml(raw);
    if (!parsed.ok) {
      return err({ kind: "config_invalid", detail: JSON.stringify(parsed.error) });
    }
    return ok(parsed.value);
  } catch (error) {
    return err({
      kind: "config_read",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

const loadRunGateConfig = (
  repoRoot: string,
  configFile: string | undefined,
): Result<ProjectGateConfig, RegimeRunError> => {
  if (configFile === undefined) return ok(skeletonGateConfig());

  try {
    const raw = readFileSync(resolve(repoRoot, configFile), "utf8");
    const parsed = parseGateToml(raw);
    if (!parsed.ok) {
      return err({ kind: "config_invalid", detail: JSON.stringify(parsed.error) });
    }
    return ok(parsed.value);
  } catch (error) {
    return err({
      kind: "config_read",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

const buildTaskRunSpec = (
  task: DogfoodTask,
  ts: Timestamp,
  config: OrchestratorConfig,
): Result<RegimeRunSpec, RegimeRunError> => {
  const paths: RepoPath[] = [];
  for (const path of task.scope) {
    const parsed = parseRepoPath(path);
    if (!parsed.ok) return err({ kind: "task_invalid", detail: `invalid scope path: ${path}` });
    paths.push(parsed.value);
  }
  const scope = makeWriteScope(paths);
  if (!scope.ok) return err({ kind: "task_invalid", detail: "scope must not be empty" });

  for (const write of task.scriptedWrites) {
    const parsed = parseRepoPath(write.path);
    if (!parsed.ok)
      return err({ kind: "task_invalid", detail: `invalid write path: ${write.path}` });
  }
  const firstWrite = task.scriptedWrites[0];
  if (firstWrite === undefined) {
    return err({ kind: "task_invalid", detail: "scriptedWrites must not be empty" });
  }

  const suffix = String(ts);
  const lineageId = LineageId(`lineage-dogfood-${suffix}`);
  const requirementId = RequirementId(`req-dogfood-${suffix}`);
  const decisionId = DecisionId(`dec-dogfood-${suffix}`);
  const transitionId = TransitionId(`tr-dogfood-${suffix}`);
  const postGateRunId = GateRunId(`gate-dogfood-${suffix}-post`);
  if (
    !lineageId.ok ||
    !requirementId.ok ||
    !decisionId.ok ||
    !transitionId.ok ||
    !postGateRunId.ok
  ) {
    return err({ kind: "task_invalid", detail: "could not build dogfood run ids" });
  }

  const criteria = task.acceptanceCriteria.map((statement, index) => ({
    id: `c${index + 1}`,
    statement,
  }));
  const acceptanceTarget = snapshotAcceptanceTarget({ criteria, frozenAt: ts });
  if (!acceptanceTarget.ok) {
    return err({ kind: "task_invalid", detail: JSON.stringify(acceptanceTarget.error) });
  }

  const door = classifyDoor(scope.value, undefined, config.door);
  const specContent = "// dogfood spec phase evidence; not applied by the spine\n";
  const specTask: PhaseTask = {
    prompt: [
      "Record a tiny dogfood spec artifact.",
      "",
      "Call scoped_write exactly once for the requested write:",
      `path: ${firstWrite.path}`,
      "content:",
      specContent,
      "The spine records this phase evidence but does not apply it to the worktree.",
    ].join("\n"),
    writes: [
      {
        path: firstWrite.path,
        content: specContent,
      },
    ],
  };
  const planContent = "// dogfood plan phase evidence; not applied by the spine\n";
  const planTask: PhaseTask = {
    prompt: [
      "Record a tiny dogfood plan artifact.",
      "",
      "Call scoped_write exactly once for the requested write:",
      `path: ${firstWrite.path}`,
      "content:",
      planContent,
      "The spine records this phase evidence but does not apply it to the worktree.",
    ].join("\n"),
    writes: [
      {
        path: firstWrite.path,
        content: planContent,
      },
    ],
  };
  const oraclePath = `src/lib/dogfood-oracle-${suffix}.test.ts`;
  const oracleContent = [
    'import { describe, expect, test } from "bun:test";',
    "",
    'describe("dogfood one-way oracle", () => {',
    '  test("acceptance criteria are frozen", () => {',
    `    expect(${task.acceptanceCriteria.length}).toBeGreaterThan(0);`,
    "  });",
    "});",
    "",
  ].join("\n");
  const oracleTask: PhaseTask = {
    prompt: [
      "Author the frozen acceptance oracle for this one-way dogfood task.",
      "",
      "Call scoped_write exactly once with the requested oracle file:",
      `path: ${oraclePath}`,
      "content:",
      oracleContent,
      "The oracle should stay small and deterministic.",
    ].join("\n"),
    writes: [
      {
        path: oraclePath,
        content: oracleContent,
      },
    ],
  };

  return ok({
    lineage: makeLineage({
      lineageId: lineageId.value,
      requirementId: requirementId.value,
      door,
      acceptanceTarget: acceptanceTarget.value,
      declaredScope: scope.value,
      createdAt: ts,
    }),
    coverage: { kind: "reuse", coveredCriteria: criteria.map((criterion) => criterion.id) },
    tasks: {
      ...(door.direction === "one_way"
        ? { spec: specTask, plan: planTask, oracle_authoring: oracleTask }
        : {}),
      implement: {
        prompt: dogfoodTaskPrompt(task),
        writes: task.scriptedWrites,
      },
    },
    ...(door.direction === "one_way" ? { oraclePaths: [oraclePath] } : {}),
    decisionReview: {
      summary: task.goal,
      scope: task.scope,
      acceptanceCriteria: task.acceptanceCriteria,
    },
    ids: {
      invocationBase: `inv-dogfood-${suffix}`,
      decisionId: decisionId.value,
      transitionId: transitionId.value,
      postGateRunId: postGateRunId.value,
    },
  });
};

export const runRegimeLineage = async (
  input: RegimeRunInput,
): Promise<Result<LineagePipelineOutcome, RegimeRunError>> => {
  const ts = parseTimestamp(Date.now());
  if (!ts.ok) return err({ kind: "invalid_default" });

  const config = loadRunConfig(input.repoRoot, input.configFile);
  if (!config.ok) return config;

  const spec =
    input.taskFile === undefined
      ? buildDefaultRunSpec(ts.value)
      : (() => {
          const task = loadTaskFile(input.repoRoot, input.taskFile);
          if (!task.ok) return task;
          return buildTaskRunSpec(task.value, ts.value, config.value);
        })();
  if (!spec.ok) return spec;

  const prepared = await prepareWorktreeGate(input.repoRoot);
  if (!prepared.ok) return err({ kind: "worktree_prepare", detail: prepared.error.kind });

  if (input.configFile === undefined) {
    writePassingGateFixture(prepared.value.worktreeRoot);
  }
  const decisionQueue = openDecisionQueueStore(
    join(input.repoRoot, DECISION_DB_DIR, DECISION_DB_FILE),
  );
  try {
    const gateConfig = loadRunGateConfig(input.repoRoot, input.configFile);
    if (!gateConfig.ok) return gateConfig;

    const outcome = await runLineageForRegime({
      repoRoot: input.repoRoot,
      runtimeRoot: input.repoRoot,
      gate: { worktreeRoot: prepared.value.worktreeRoot, config: gateConfig.value },
      lineage: spec.value.lineage,
      config: config.value,
      coverage: spec.value.coverage,
      tasks: spec.value.tasks,
      ...(spec.value.oraclePaths === undefined ? {} : { oraclePaths: spec.value.oraclePaths }),
      ids: spec.value.ids,
      decisionQueue,
      decisionId: spec.value.ids.decisionId,
      decisionReview: spec.value.decisionReview,
      at: ts.value,
    });

    if (!outcome.ok) return err({ kind: "pipeline", detail: JSON.stringify(outcome.error) });
    return ok(outcome.value);
  } finally {
    decisionQueue.close();
    await prepared.value.dispose();
  }
};
