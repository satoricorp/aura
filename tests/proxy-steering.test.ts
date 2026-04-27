import { describe, expect, test } from "bun:test";
import { evaluateToolSteering } from "../src/core/proxy/steering";

describe("evaluateToolSteering", () => {
  test("allows an in-scope README edit", () => {
    expect(
      evaluateToolSteering({
        originalTask: "Add a line to README.md",
        toolCalls: [
          {
            input: { file_path: "README.md", new_string: "hello" },
            summary: "Edit README.md",
            tool_name: "Edit",
          },
        ],
      }),
    ).toEqual({ action: "allow" });
  });

  test("requests correction for destructive shell commands", () => {
    const decision = evaluateToolSteering({
      originalTask: "Clean up temp files",
      toolCalls: [
        {
          input: { command: "rm -rf /tmp/aura" },
          summary: "Bash rm -rf /tmp/aura",
          tool_name: "Bash",
        },
      ],
    });

    expect(decision.action).toBe("correct");
    expect(decision).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining("destructive command"),
      }),
    );
  });

  test("warns on obvious scope drift", () => {
    const decision = evaluateToolSteering({
      originalTask: "Edit README.md",
      toolCalls: [
        {
          input: { file_path: "package.json", new_string: "{}" },
          summary: "Edit package.json",
          tool_name: "Edit",
        },
      ],
    });

    expect(decision).toEqual({
      action: "warn",
      message: "Tool call touches `package.json`, which may be outside the requested scope.",
    });
  });
});
