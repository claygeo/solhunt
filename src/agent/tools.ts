import Anthropic from "@anthropic-ai/sdk";

// Claude's built-in trained tools perform better than custom equivalents.
// We define them using the special type field, not input_schema.

export type ToolDefinition = Anthropic.Tool | Anthropic.ToolBash20250124 | Anthropic.ToolTextEditor20250124;

export function getToolDefinitions(): ToolDefinition[] {
  return [
    // Built-in bash tool (trained into the model)
    {
      type: "bash_20250124",
      name: "bash",
    },

    // Built-in text editor tool (trained into the model)
    {
      type: "text_editor_20250124",
      name: "str_replace_editor",
    },

    // Custom: read file contents
    {
      name: "read_file",
      description:
        "Read the contents of a file at the given path inside the sandbox.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file to read",
          },
        },
        required: ["path"],
      },
    },

    // Custom: run forge test with parsed output
    {
      name: "forge_test",
      description:
        "Run forge test inside the sandbox. Returns the test output including pass/fail status and call traces.",
      input_schema: {
        type: "object" as const,
        properties: {
          test_file: {
            type: "string",
            description:
              "Path to the test file relative to the project root (e.g., test/Exploit.t.sol)",
          },
          verbosity: {
            type: "number",
            description:
              "Verbosity level 1-5. Default 3 (-vvv). Higher shows more call trace detail.",
          },
          function_name: {
            type: "string",
            description:
              "Optional: specific test function to run (e.g., testExploit)",
          },
        },
        required: ["test_file"],
      },
    },
  ];
}
