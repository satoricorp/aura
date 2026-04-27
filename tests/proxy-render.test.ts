import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
  renderAssistantVerdict,
  renderVerdict,
  renderVerdictJsonLine,
  renderVerdictUnavailable,
  renderVerdictUnavailableJsonLine,
} from "../src/core/proxy/render";

describe("renderVerdict", () => {
  test("renders fixed-width verdict details", () => {
    const output = stripVTControlCharacters(
      renderVerdict({
        status: "REVIEW",
        summary: "Parser fixed with a test risk that should be checked",
        task_understanding: "Fix the parser null check",
        changes: [
          {
            action: "modified",
            note: "updated the null check",
            path: "src/utils/parser.ts",
          },
        ],
        risks: ["Tests were not run"],
        claimed_vs_actual: ["Claimed tests pass without a test command"],
        next_step: "Run parser tests",
      }),
    );

    expect(output).toContain("AURA");
    expect(output).toContain("⚠ REVIEW");
    expect(output).toContain("~ src/utils/parser.ts");
    expect(output).toContain("Risks:");
    expect(output.split("\n").every((line) => line.length <= 60)).toBe(true);
  });

  test("renders fallback unavailable output", () => {
    const output = renderVerdictUnavailable("network failed", "/tmp/session.jsonl");

    expect(output).toContain("Verdict unavailable: network failed");
    expect(output).toContain("/tmp/session.jsonl");
  });

  test("renders readable assistant verdict without terminal truncation", () => {
    const output = renderAssistantVerdict({
      status: "APPROVED",
      summary: "README line added",
      task_understanding: "Add an extra line to README",
      changes: [
        {
          action: "modified",
          note: "added testing aura 1 at the end of the README",
          path: "/Users/joe/git/aura/README.md",
        },
      ],
      risks: [],
      claimed_vs_actual: [],
      next_step: "Ready to commit",
    });

    expect(output).toContain("Aura: APPROVED - README line added");
    expect(output).toContain(
      "- modified /Users/joe/git/aura/README.md: added testing aura 1 at the end of the README",
    );
    expect(output).not.toContain("…");
  });

  test("renders verdict JSON as a single line", () => {
    const output = renderVerdictJsonLine({
      injected: true,
      model: "claude-haiku-test",
      requestId: "req_test",
      verdict: {
        status: "APPROVED",
        summary: "README line added",
        task_understanding: "Add an extra line to README",
        changes: [
          {
            action: "modified",
            note: "added a line",
            path: "README.md",
          },
        ],
        risks: [],
        claimed_vs_actual: [],
        next_step: "Ready to commit",
      },
    });

    expect(output).not.toContain("\n");
    expect(JSON.parse(output)).toEqual({
      type: "aura_verdict",
      model: "claude-haiku-test",
      request_id: "req_test",
      injected: true,
      status: "APPROVED",
      summary: "README line added",
      task_understanding: "Add an extra line to README",
      changes: [{ action: "modified", note: "added a line", path: "README.md" }],
      risks: [],
      claimed_vs_actual: [],
      next_step: "Ready to commit",
    });
  });

  test("colorizes verdict JSON when requested", () => {
    const output = renderVerdictJsonLine({
      color: true,
      injected: true,
      model: "claude-haiku-test",
      requestId: "req_test",
      verdict: {
        status: "REVIEW",
        summary: "Check parser tests",
        task_understanding: "Fix parser",
        changes: [],
        risks: ["Tests were not run"],
        claimed_vs_actual: [],
        next_step: "Run tests",
      },
    });
    const plain = stripVTControlCharacters(output);

    expect(output).toContain("\u001b[");
    expect(output).not.toContain("\n");
    expect(JSON.parse(plain)).toEqual({
      type: "aura_verdict",
      model: "claude-haiku-test",
      request_id: "req_test",
      injected: true,
      status: "REVIEW",
      summary: "Check parser tests",
      task_understanding: "Fix parser",
      changes: [],
      risks: ["Tests were not run"],
      claimed_vs_actual: [],
      next_step: "Run tests",
    });
  });

  test("renders unavailable verdict JSON as a single line", () => {
    const output = renderVerdictUnavailableJsonLine({
      error: "network failed",
      injected: false,
      model: "claude-haiku-test",
      requestId: "req_test",
      sessionLogPath: "/tmp/session.jsonl",
    });

    expect(output).not.toContain("\n");
    expect(JSON.parse(output)).toEqual({
      type: "aura_verdict_unavailable",
      model: "claude-haiku-test",
      request_id: "req_test",
      injected: false,
      error: "network failed",
      session_log_path: "/tmp/session.jsonl",
    });
  });
});
