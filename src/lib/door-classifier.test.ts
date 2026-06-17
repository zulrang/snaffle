import { describe, expect, test } from "bun:test";
import { ONE_WAY_TRIGGERS } from "../domain/door";
import { makeWriteScope, parseRepoPath } from "../domain/scope";
import { classifyDoor, matchPathPattern } from "./door-classifier";
import { type DoorTaxonomyConfig, parseOrchestratorToml } from "./orchestrator-config";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

const scope = (paths: string[]) => must(makeWriteScope(paths.map((p) => must(parseRepoPath(p)))));

const fixtureTaxonomy = (): DoorTaxonomyConfig => ({
  pathPatterns: {
    auth: ["**/auth/**", "src/security/**"],
    money: ["**/billing/**", "**/payment/**"],
    persisted_schema: ["**/migrations/**"],
    public_contract: ["**/api/public/**"],
    irreversible_migration: ["**/migrations/irreversible/**"],
  },
  tagPatterns: {
    auth: ["authentication", "oauth"],
    money: ["billing", "payments"],
  },
});

describe("S1/W2 — config-driven door classifier (D5/D15)", () => {
  test("classifies each trigger type from declared path patterns", () => {
    const config = fixtureTaxonomy();
    for (const trigger of ONE_WAY_TRIGGERS) {
      const samplePath =
        trigger === "auth"
          ? "src/auth/login.ts"
          : trigger === "money"
            ? "lib/billing/invoice.ts"
            : trigger === "persisted_schema"
              ? "db/migrations/001_init.sql"
              : trigger === "public_contract"
                ? "src/api/public/v1.ts"
                : "db/migrations/irreversible/drop.sql";
      const door = classifyDoor(scope([samplePath]), undefined, config);
      expect(door.direction).toBe("one_way");
      if (door.direction === "one_way") {
        expect(door.triggers).toContain(trigger);
      }
    }
  });

  test("two-way default when scope matches no patterns", () => {
    const door = classifyDoor(scope(["src/utils/format.ts"]), undefined, fixtureTaxonomy());
    expect(door).toEqual({ direction: "two_way" });
  });

  test("tag hints activate configured triggers", () => {
    const door = classifyDoor(scope(["src/feature/x.ts"]), { tags: ["oauth"] }, fixtureTaxonomy());
    expect(door).toEqual({ direction: "one_way", triggers: ["auth"] });
  });

  test("ambiguous hint forces conservative one-way default", () => {
    const door = classifyDoor(
      scope(["src/utils/format.ts"]),
      { ambiguous: true },
      fixtureTaxonomy(),
    );
    expect(door).toEqual({ direction: "one_way", triggers: [], ambiguous: true });
  });

  test("undecidable scope with no pattern match stays two-way unless ambiguous", () => {
    const emptyPatterns: DoorTaxonomyConfig = { pathPatterns: {}, tagPatterns: {} };
    const door = classifyDoor(scope(["src/unknown/widget.ts"]), undefined, emptyPatterns);
    expect(door.direction).toBe("two_way");
  });

  test("glob matcher supports segment and cross-segment wildcards", () => {
    const path = must(parseRepoPath("src/auth/oauth/callback.ts"));
    expect(matchPathPattern("**/auth/**", path)).toBe(true);
    expect(matchPathPattern("src/security/**", must(parseRepoPath("src/security/guard.ts")))).toBe(
      true,
    );
    expect(matchPathPattern("src/auth/**", path)).toBe(true);
    expect(matchPathPattern("**/billing/**", must(parseRepoPath("lib/billing/x.ts")))).toBe(true);
  });

  test("merges multiple triggers when scope spans concerns", () => {
    const door = classifyDoor(
      scope(["src/auth/session.ts", "lib/billing/plans.ts"]),
      undefined,
      fixtureTaxonomy(),
    );
    expect(door.direction).toBe("one_way");
    if (door.direction === "one_way") {
      expect(door.triggers).toContain("auth");
      expect(door.triggers).toContain("money");
    }
  });
});

describe("S1 — fixture repo with gate.toml door taxonomy", () => {
  test("loads config and classifies known scopes without hardcoded lib triggers", () => {
    const project = must(
      parseOrchestratorToml(`
[door]
auth = ["**/auth/**"]
money = ["**/payment/**"]
`),
    );

    const authDoor = classifyDoor(scope(["services/auth/token.ts"]), undefined, project.door);
    expect(authDoor).toEqual({ direction: "one_way", triggers: ["auth"] });

    const moneyDoor = classifyDoor(scope(["services/payment/charge.ts"]), undefined, project.door);
    expect(moneyDoor).toEqual({ direction: "one_way", triggers: ["money"] });

    const twoWay = classifyDoor(scope(["services/util/helpers.ts"]), undefined, project.door);
    expect(twoWay.direction).toBe("two_way");
  });
});
