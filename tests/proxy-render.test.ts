import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderVerdict, renderVerdictUnavailable } from "../src/core/proxy/render";

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
});
