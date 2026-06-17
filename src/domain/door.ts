import { err, ok, type Result } from "./shared";

/**
 * Door classification and process regime (D5, D25).
 *
 * Process tracks reversibility, not uniformity. A change is a one-way door if it
 * touches an irreversible concern; otherwise it is two-way. The door selects the
 * regime — `full` (formal spec/plan, dedicated oracle authoring, mandatory human
 * sign-off) or `minimal` (inline target, reused oracle, auto-merge on green) —
 * but both regimes share the same non-collapsible integrity floor.
 */

/** Concerns that make a change irreversible and therefore a one-way door. */
export const ONE_WAY_TRIGGERS = [
  "money",
  "auth",
  "persisted_schema",
  "public_contract",
  "irreversible_migration",
] as const;

export type OneWayTrigger = (typeof ONE_WAY_TRIGGERS)[number];

export type DoorDirection = "one_way" | "two_way";

/**
 * A door classification. A one-way door records the trigger(s) that made it
 * irreversible; when it was forced one-way by *undecidability* rather than a
 * concrete trigger, `ambiguous` is set so the audit trail says "conservative
 * default" instead of inventing a trigger that did not fire. A two-way door
 * carries neither.
 */
export type DoorClassification =
  | {
      readonly direction: "one_way";
      readonly triggers: readonly OneWayTrigger[];
      readonly ambiguous?: true;
    }
  | { readonly direction: "two_way" };

export interface NoTriggersError {
  readonly kind: "one_way_without_triggers";
}

export const classifyOneWay = (
  triggers: readonly OneWayTrigger[],
): Result<DoorClassification, NoTriggersError> => {
  if (triggers.length === 0) return err({ kind: "one_way_without_triggers" });
  return ok({ direction: "one_way", triggers });
};

export const classifyTwoWay = (): DoorClassification => ({ direction: "two_way" });

/**
 * Conservative default for ambiguity (Risks §9): an undecidable change is
 * treated as a one-way door so it cannot bypass the human gate. The `ambiguous`
 * flag records *why* it is one-way (undecidability, not a fired trigger); any
 * triggers that were detected but could not be resolved are carried alongside.
 */
export const classifyAmbiguousAsOneWay = (
  triggers: readonly OneWayTrigger[],
): DoorClassification => ({ direction: "one_way", triggers, ambiguous: true });

// ---------------------------------------------------------------------------
// Regime (D25)
// ---------------------------------------------------------------------------

export type Regime = "minimal" | "full";

/** The regime is a pure function of the door: one-way ⇒ full, two-way ⇒ minimal. */
export const regimeForDoor = (door: DoorClassification): Regime =>
  door.direction === "one_way" ? "full" : "minimal";

/** One-way doors require a human sign-off before merge (D11). */
export const requiresHumanSignOff = (door: DoorClassification): boolean =>
  door.direction === "one_way";
