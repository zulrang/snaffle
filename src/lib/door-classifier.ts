import {
  classifyAmbiguousAsOneWay,
  classifyOneWay,
  classifyTwoWay,
  type DoorClassification,
  type OneWayTrigger,
} from "../domain/door";
import type { RepoPath, WriteScope } from "../domain/scope";
import type { DoorTaxonomyConfig } from "./orchestrator-config";

/**
 * Optional admission hints — path tags from the caller; ambiguous forces conservative one-way (D5, Risks §9).
 */
export interface DoorHints {
  readonly tags?: readonly string[];
  readonly ambiguous?: boolean;
}

/** ponytail: naive glob — `*` within segment, `**` across segments; upgrade path is micromatch. */
const globToRegExp = (pattern: string): RegExp => {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**", i)) {
      regex += ".*";
      i += 2;
      continue;
    }
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      regex += "[^/]*";
    } else if (/[+?^${}()|[\]\\]/.test(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
    i += 1;
  }
  regex += "$";
  return new RegExp(regex);
};

export const matchPathPattern = (pattern: string, path: RepoPath): boolean =>
  globToRegExp(pattern).test(path);

const triggersFromPaths = (
  paths: readonly RepoPath[],
  config: DoorTaxonomyConfig,
): OneWayTrigger[] => {
  const found = new Set<OneWayTrigger>();
  for (const [trigger, patterns] of Object.entries(config.pathPatterns) as [
    OneWayTrigger,
    readonly string[] | undefined,
  ][]) {
    if (patterns === undefined) continue;
    for (const path of paths) {
      if (patterns.some((pattern) => matchPathPattern(pattern, path))) {
        found.add(trigger);
        break;
      }
    }
  }
  return [...found];
};

const triggersFromTags = (tags: readonly string[], config: DoorTaxonomyConfig): OneWayTrigger[] => {
  const normalized = new Set(tags.map((tag) => tag.toLocaleLowerCase()));
  const found = new Set<OneWayTrigger>();
  for (const [trigger, patterns] of Object.entries(config.tagPatterns) as [
    OneWayTrigger,
    readonly string[] | undefined,
  ][]) {
    if (patterns === undefined) continue;
    if (patterns.some((tag) => normalized.has(tag.toLocaleLowerCase()))) {
      found.add(trigger);
    }
  }
  return [...found];
};

const mergeTriggers = (...groups: readonly OneWayTrigger[][]): readonly OneWayTrigger[] => {
  const merged = new Set<OneWayTrigger>();
  for (const group of groups) {
    for (const trigger of group) merged.add(trigger);
  }
  return [...merged];
};

/**
 * Config-driven door classifier (D5, D15). Trigger literals live only in project config;
 * dispatch iterates declared patterns — no hardcoded path substrings in `lib/`.
 */
export const classifyDoor = (
  scope: WriteScope,
  hints: DoorHints | undefined,
  config: DoorTaxonomyConfig,
): DoorClassification => {
  if (hints?.ambiguous === true) {
    return classifyAmbiguousAsOneWay([]);
  }

  const pathTriggers = triggersFromPaths(scope.allowedPaths, config);
  const tagTriggers =
    hints?.tags !== undefined && hints.tags.length > 0 ? triggersFromTags(hints.tags, config) : [];

  const triggers = mergeTriggers(pathTriggers, tagTriggers);

  if (triggers.length === 0) {
    return classifyTwoWay();
  }

  const classified = classifyOneWay(triggers);
  return classified.ok ? classified.value : classifyAmbiguousAsOneWay(triggers);
};
