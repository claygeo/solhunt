import { describe, it, expect } from "vitest";
import { getToolDefinitions } from "../../src/agent/tools.js";

describe("getToolDefinitions", () => {
  it("returns all required tools", () => {
    const tools = getToolDefinitions();
    const names = tools.map((t) => t.name);

    expect(names).toContain("bash");
    expect(names).toContain("str_replace_editor");
    expect(names).toContain("read_file");
    expect(names).toContain("forge_test");
  });

  it("bash tool uses built-in type", () => {
    const tools = getToolDefinitions();
    const bash = tools.find((t) => t.name === "bash") as any;
    expect(bash.type).toBe("bash_20250124");
  });

  it("text_editor tool uses built-in type", () => {
    const tools = getToolDefinitions();
    const editor = tools.find((t) => t.name === "str_replace_editor") as any;
    expect(editor.type).toBe("text_editor_20250124");
  });

  it("custom tools have input_schema", () => {
    const tools = getToolDefinitions();
    const readFile = tools.find((t) => t.name === "read_file") as any;
    const forgeTest = tools.find((t) => t.name === "forge_test") as any;

    expect(readFile.input_schema).toBeDefined();
    expect(readFile.input_schema.properties.path).toBeDefined();

    expect(forgeTest.input_schema).toBeDefined();
    expect(forgeTest.input_schema.properties.test_file).toBeDefined();
    expect(forgeTest.input_schema.required).toContain("test_file");
  });
});
