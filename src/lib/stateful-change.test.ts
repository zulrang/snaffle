import { describe, expect, test } from "bun:test";
import { classifyOneWay, classifyTwoWay } from "../domain/door";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { detectStatefulChange } from "./stateful-change";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const scope = (paths: readonly string[]) =>
  must(makeWriteScope(paths.map((p) => must(parseRepoPath(p)))));

describe("W1 — stateful change detector (D9)", () => {
  test("persisted_schema door trigger classifies as stateful", () => {
    expect(
      detectStatefulChange({
        scope: scope(["src/lib/feature.ts"]),
        door: must(classifyOneWay(["persisted_schema"])),
      }),
    ).toBe("stateful");
  });

  test("public_contract trigger classifies as stateful", () => {
    expect(
      detectStatefulChange({
        scope: scope(["src/api/routes.ts"]),
        door: must(classifyOneWay(["public_contract"])),
      }),
    ).toBe("stateful");
  });

  test("contract surface change classifies as stateful", () => {
    expect(
      detectStatefulChange({
        scope: scope(["src/lib/feature.ts"]),
        door: classifyTwoWay(),
        contractSurfaceChanged: true,
      }),
    ).toBe("stateful");
  });

  test("pure code/doc two-way change is non-stateful", () => {
    expect(
      detectStatefulChange({
        scope: scope(["src/lib/feature.ts", "docs/readme.md"]),
        door: classifyTwoWay(),
      }),
    ).toBe("non_stateful");
  });

  test("ambiguous one-way defaults to stateful (conservative)", () => {
    expect(
      detectStatefulChange({
        scope: scope(["src/lib/feature.ts"]),
        door: { direction: "one_way", triggers: [], ambiguous: true },
      }),
    ).toBe("stateful");
  });

  test("migration path in scope classifies as stateful", () => {
    expect(
      detectStatefulChange({
        scope: scope(["db/migrations/001_add_column.sql"]),
        door: classifyTwoWay(),
      }),
    ).toBe("stateful");
  });
});
