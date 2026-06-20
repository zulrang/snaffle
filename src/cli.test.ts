import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./cli.ts";

describe("cli entry — parseCliArgs", () => {
  test("rejects unknown flags", () => {
    expect(parseCliArgs(["run", "--nope"])).toBeUndefined();
  });

  test("parses --live on run", () => {
    const parsed = parseCliArgs(["run", "--live", "--task-file", "docs/x.json"]);
    expect(parsed?.live).toBe(true);
    expect(parsed?.taskFile).toBe("docs/x.json");
  });

  test("run defaults live to false", () => {
    expect(parseCliArgs(["run"])?.live).toBe(false);
  });
});
