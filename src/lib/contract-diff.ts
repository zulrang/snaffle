import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GateCheckKind, GateCheckResult } from "../domain/gate";
import { type ContentHash, err, ok, parseContentHash, type Result } from "../domain/shared";
import { hashCanonicalJson, hashUtf8 } from "./provenance-hash";

/**
 * Contract-diff stage (D8, S1/W4).
 *
 * Deterministically detects silently reshaped exported interfaces and Pi tool
 * schemas by comparing a captured baseline to the current tree.
 */

export interface ExportedInterfaceSurface {
  readonly name: string;
  /** Sorted `field: type` signatures — internal renames don't affect export shape. */
  readonly fields: readonly string[];
}

export interface ToolSchemaSurface {
  readonly name: string;
  readonly schemaHash: ContentHash;
}

export interface ContractSurface {
  readonly interfaces: readonly ExportedInterfaceSurface[];
  readonly tools: readonly ToolSchemaSurface[];
}

export interface ContractBaseline {
  readonly hash: ContentHash;
  readonly surface: ContractSurface;
}

const INTERFACE_RE = /export\s+interface\s+(\w+)\s*\{([^}]*)\}/g;
const FIELD_RE = /^\s*(\w+)\s*:\s*([^;]+);/gm;
const TOOL_SCHEMA_RE = /const\s+(\w+Schema)\s*=\s*Type\.Object\(\{([^}]*)\}/g;
const TOOL_PROPERTY_RE = /(\w+):\s*Type\.(\w+)\(/g;

/** Extract exported interface field signatures from TypeScript source. */
export const extractExportedInterfaces = (source: string): ExportedInterfaceSurface[] => {
  const interfaces: ExportedInterfaceSurface[] = [];
  for (const match of source.matchAll(INTERFACE_RE)) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) continue;

    const fields: string[] = [];
    for (const fieldMatch of body.matchAll(FIELD_RE)) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2]?.trim();
      if (fieldName !== undefined && fieldType !== undefined) {
        fields.push(`${fieldName}: ${fieldType}`);
      }
    }
    fields.sort((a, b) => a.localeCompare(b));
    interfaces.push({ name, fields });
  }
  interfaces.sort((a, b) => a.name.localeCompare(b.name));
  return interfaces;
};

/** Extract Pi tool schema shapes from Type.Object definitions. */
export const extractToolSchemas = (source: string): ToolSchemaSurface[] => {
  const tools: ToolSchemaSurface[] = [];
  for (const match of source.matchAll(TOOL_SCHEMA_RE)) {
    const schemaName = match[1];
    const body = match[2];
    if (schemaName === undefined || body === undefined) continue;

    const properties: string[] = [];
    for (const propMatch of body.matchAll(TOOL_PROPERTY_RE)) {
      const propName = propMatch[1];
      const propType = propMatch[2];
      if (propName !== undefined && propType !== undefined) {
        properties.push(`${propName}:${propType}`);
      }
    }
    properties.sort((a, b) => a.localeCompare(b));
    const toolName = schemaName.replace(/Schema$/, "");
    tools.push({
      name: toolName,
      schemaHash: hashUtf8(properties.join("|")),
    });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
};

export const buildContractSurface = (
  sources: readonly { readonly path: string; readonly content: string }[],
): ContractSurface => {
  const interfaces: ExportedInterfaceSurface[] = [];
  const tools: ToolSchemaSurface[] = [];

  for (const source of sources) {
    interfaces.push(...extractExportedInterfaces(source.content));
    tools.push(...extractToolSchemas(source.content));
  }

  interfaces.sort((a, b) => a.name.localeCompare(b.name));
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { interfaces, tools };
};

export const hashContractSurface = (surface: ContractSurface): ContentHash =>
  hashCanonicalJson(surface);

export const captureContractBaseline = (
  sources: readonly { readonly path: string; readonly content: string }[],
): ContractBaseline => {
  const surface = buildContractSurface(sources);
  return { surface, hash: hashContractSurface(surface) };
};

export type ContractDiffError =
  | { readonly kind: "interface_reshaped"; readonly name: string; readonly detail: string }
  | { readonly kind: "tool_schema_reshaped"; readonly name: string; readonly detail: string }
  | { readonly kind: "interface_removed"; readonly name: string }
  | { readonly kind: "tool_removed"; readonly name: string };

const fieldsEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((field, index) => field === b[index]);

/** Compare current surface to baseline; flag reshaped exports and tool schemas. */
export const diffContractSurfaces = (
  baseline: ContractSurface,
  current: ContractSurface,
): Result<void, ContractDiffError> => {
  const baselineInterfaces = new Map(baseline.interfaces.map((item) => [item.name, item]));
  for (const iface of current.interfaces) {
    const previous = baselineInterfaces.get(iface.name);
    if (previous === undefined) continue;
    if (!fieldsEqual(previous.fields, iface.fields)) {
      return err({
        kind: "interface_reshaped",
        name: iface.name,
        detail: `was [${previous.fields.join(", ")}]; now [${iface.fields.join(", ")}]`,
      });
    }
    baselineInterfaces.delete(iface.name);
  }

  const baselineTools = new Map(baseline.tools.map((item) => [item.name, item]));
  for (const tool of current.tools) {
    const previous = baselineTools.get(tool.name);
    if (previous === undefined) continue;
    if (previous.schemaHash !== tool.schemaHash) {
      return err({
        kind: "tool_schema_reshaped",
        name: tool.name,
        detail: "tool schema shape changed",
      });
    }
    baselineTools.delete(tool.name);
  }

  return ok(undefined);
};

export const loadContractSources = (
  worktreeRoot: string,
  relativePaths: readonly string[],
): Result<
  readonly { readonly path: string; readonly content: string }[],
  { readonly kind: "read_error"; readonly path: string }
> => {
  const sources: Array<{ path: string; content: string }> = [];
  for (const rel of relativePaths) {
    try {
      sources.push({ path: rel, content: readFileSync(join(worktreeRoot, rel), "utf8") });
    } catch {
      return err({ kind: "read_error", path: rel });
    }
  }
  return ok(sources);
};

export const runContractDiffCheck = (
  worktreeRoot: string,
  contractPaths: readonly string[],
  baseline: ContractBaseline,
): GateCheckResult => {
  const kind = "contract_diff" as const satisfies GateCheckKind;
  if (contractPaths.length === 0) {
    return { kind, status: "skipped" };
  }

  const sources = loadContractSources(worktreeRoot, contractPaths);
  if (!sources.ok) {
    return { kind, status: "failed", detail: `missing contract source: ${sources.error.path}` };
  }

  const current = buildContractSurface(sources.value);
  const diff = diffContractSurfaces(baseline.surface, current);
  if (!diff.ok) {
    return { kind, status: "failed", detail: `${diff.error.kind}: ${diff.error.name}` };
  }

  return { kind, status: "passed" };
};

export const saveContractBaseline = (
  worktreeRoot: string,
  relPath: string,
  baseline: ContractBaseline,
): Result<void, { readonly kind: "write_error"; readonly detail: string }> => {
  try {
    mkdirSync(dirname(join(worktreeRoot, relPath)), { recursive: true });
    writeFileSync(join(worktreeRoot, relPath), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    return ok(undefined);
  } catch (error) {
    return err({
      kind: "write_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

export const loadContractBaseline = (
  worktreeRoot: string,
  relPath: string,
): Result<
  ContractBaseline | undefined,
  { readonly kind: "parse_error"; readonly detail: string }
> => {
  try {
    const raw = readFileSync(join(worktreeRoot, relPath), "utf8");
    const parsed = JSON.parse(raw) as { hash?: unknown; surface?: unknown };
    if (
      typeof parsed.hash !== "string" ||
      typeof parsed.surface !== "object" ||
      parsed.surface === null
    ) {
      return err({ kind: "parse_error", detail: "invalid contract baseline shape" });
    }
    const hash = parseContentHash(parsed.hash);
    if (!hash.ok) return err({ kind: "parse_error", detail: "invalid contract baseline hash" });
    const surface = parsed.surface as ContractSurface;
    const baseline: ContractBaseline = { hash: hash.value, surface };
    if (hashContractSurface(surface) !== baseline.hash) {
      return err({ kind: "parse_error", detail: "contract baseline hash mismatch" });
    }
    return ok(baseline);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ok(undefined);
    return err({
      kind: "parse_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
