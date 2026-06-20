import { err, ok, type Result } from "../domain/shared";

/**
 * Dogfood task contract: goal, scope, acceptance criteria, and optional
 * `scriptedWrites` for faux-backed runs. Omit writes when using `--live`.
 */

export interface DogfoodScriptedWrite {
  readonly path: string;
  readonly content: string;
}

export interface DogfoodTask {
  readonly goal: string;
  readonly scope: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly scriptedWrites: readonly DogfoodScriptedWrite[];
}

export type DogfoodTaskParseError = {
  readonly kind: "invalid_dogfood_task";
  readonly detail: string;
};

interface DogfoodTaskRecord {
  readonly goal?: unknown;
  readonly scope?: unknown;
  readonly acceptanceCriteria?: unknown;
  readonly scriptedWrites?: unknown;
}

interface DogfoodScriptedWriteRecord {
  readonly path?: unknown;
  readonly content?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseNonEmptyString = (
  value: unknown,
  field: string,
): Result<string, DogfoodTaskParseError> => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return err({ kind: "invalid_dogfood_task", detail: `${field} must be a non-empty string` });
  }
  return ok(value.trim());
};

const parseString = (value: unknown, field: string): Result<string, DogfoodTaskParseError> => {
  if (typeof value !== "string") {
    return err({ kind: "invalid_dogfood_task", detail: `${field} must be a string` });
  }
  return ok(value);
};

const parseStringArray = (
  value: unknown,
  field: string,
): Result<readonly string[], DogfoodTaskParseError> => {
  if (!Array.isArray(value) || value.length === 0) {
    return err({ kind: "invalid_dogfood_task", detail: `${field} must be a non-empty array` });
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseNonEmptyString(item, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return ok(out);
};

const parseScriptedWrites = (
  value: unknown,
): Result<readonly DogfoodScriptedWrite[], DogfoodTaskParseError> => {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) {
    return err({
      kind: "invalid_dogfood_task",
      detail: "scriptedWrites must be an array when present",
    });
  }
  if (value.length === 0) return ok([]);
  const writes: DogfoodScriptedWrite[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return err({
        kind: "invalid_dogfood_task",
        detail: `scriptedWrites[${index}] must be an object`,
      });
    }
    const write = item as DogfoodScriptedWriteRecord;
    const path = parseNonEmptyString(write.path, `scriptedWrites[${index}].path`);
    if (!path.ok) return path;
    const content = parseString(write.content, `scriptedWrites[${index}].content`);
    if (!content.ok) return content;
    writes.push({ path: path.value, content: content.value });
  }
  return ok(writes);
};

export const parseDogfoodTask = (raw: string): Result<DogfoodTask, DogfoodTaskParseError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return err({
      kind: "invalid_dogfood_task",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (!isRecord(parsed)) {
    return err({ kind: "invalid_dogfood_task", detail: "task file must be a JSON object" });
  }

  const task = parsed as DogfoodTaskRecord;
  const goal = parseNonEmptyString(task.goal, "goal");
  if (!goal.ok) return goal;
  const scope = parseStringArray(task.scope, "scope");
  if (!scope.ok) return scope;
  const acceptanceCriteria = parseStringArray(task.acceptanceCriteria, "acceptanceCriteria");
  if (!acceptanceCriteria.ok) return acceptanceCriteria;
  const scriptedWrites = parseScriptedWrites(task.scriptedWrites);
  if (!scriptedWrites.ok) return scriptedWrites;

  return ok({
    goal: goal.value,
    scope: scope.value,
    acceptanceCriteria: acceptanceCriteria.value,
    scriptedWrites: scriptedWrites.value,
  });
};

export const dogfoodTaskPrompt = (task: DogfoodTask): string =>
  [
    task.goal,
    "",
    "Declared write scope:",
    ...task.scope.map((path) => `- ${path}`),
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    ...(task.scriptedWrites.length === 0
      ? [
          "Use scoped_write only for paths under the declared scope.",
          "The spine runs acceptance checks after you finish; do not edit control-plane code.",
        ]
      : [
          "For this dogfood phase, call scoped_write exactly once for each requested write:",
          ...task.scriptedWrites.map(
            (write, index) => `${index + 1}. path: ${write.path}\ncontent:\n${write.content}`,
          ),
          "",
          "Do not write outside the declared scope.",
        ]),
  ].join("\n");
