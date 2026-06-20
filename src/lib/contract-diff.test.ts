import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContractSurface,
  captureContractBaseline,
  diffContractSurfaces,
  extractExportedInterfaces,
  extractToolSchemas,
  runContractDiffCheck,
  saveContractBaseline,
} from "./contract-diff";

describe("S1 — contract-diff teeth", () => {
  const baselineSource = `
export interface UserProfile {
  id: string;
  name: string;
}

const writeSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
});
`;

  test("flags a reshaped exported interface", () => {
    const baseline = captureContractBaseline([{ path: "api.ts", content: baselineSource }]);
    const reshaped = `
export interface UserProfile {
  id: string;
  email: string;
}
`;
    const current = buildContractSurface([{ path: "api.ts", content: reshaped }]);
    const diff = diffContractSurfaces(baseline.surface, current);
    expect(diff.ok).toBe(false);
    if (diff.ok) throw new Error("expected reshape detection");
    expect(diff.error.kind).toBe("interface_reshaped");
  });

  test("allows behavior-preserving internal reorder", () => {
    const reordered = `
export interface UserProfile {
  name: string;
  id: string;
}
`;
    const baseline = captureContractBaseline([{ path: "api.ts", content: baselineSource }]);
    const current = buildContractSurface([{ path: "api.ts", content: reordered }]);
    expect(diffContractSurfaces(baseline.surface, current).ok).toBe(true);
  });

  test("flags a reshaped Pi tool schema", () => {
    const baseline = captureContractBaseline([{ path: "tools.ts", content: baselineSource }]);
    const reshapedTool = `
const writeSchema = Type.Object({
  path: Type.String(),
  content: Type.Number(),
});
`;
    const current = buildContractSurface([{ path: "tools.ts", content: reshapedTool }]);
    const diff = diffContractSurfaces(baseline.surface, current);
    expect(diff.ok).toBe(false);
    if (diff.ok) throw new Error("expected tool schema detection");
    expect(diff.error.kind).toBe("tool_schema_reshaped");
  });

  test("extracts interfaces and tool schemas deterministically", () => {
    const interfaces = extractExportedInterfaces(baselineSource);
    expect(interfaces[0]?.name).toBe("UserProfile");
    expect(interfaces[0]?.fields).toEqual(["id: string", "name: string"]);

    const tools = extractToolSchemas(baselineSource);
    expect(tools[0]?.name).toBe("write");
  });

  test("integrated contract_diff stage is red on reshape", () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-contract-"));
    writeFileSync(join(root, "api.ts"), baselineSource, "utf8");
    const baseline = captureContractBaseline([{ path: "api.ts", content: baselineSource }]);
    saveContractBaseline(root, ".snaffle/contract-baseline.json", baseline);

    writeFileSync(
      join(root, "api.ts"),
      `export interface UserProfile { id: string; email: string; }`,
      "utf8",
    );

    const result = runContractDiffCheck(root, ["api.ts"], baseline);
    expect(result.kind).toBe("contract_diff");
    expect(result.status).toBe("failed");

    rmSync(root, { recursive: true, force: true });
  });
});
