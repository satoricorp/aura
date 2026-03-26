import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { formatHomeScreen } from "../src/cli/utils/format";

describe("formatHomeScreen", () => {
  test("renders branding, status, and context-aware next steps", () => {
    const output = formatHomeScreen({
      cliVersion: "abc1234",
      hasAuraFile: false,
      hasConfigFile: false,
      authenticated: false,
      needsRefresh: false,
    });

    expect(output).toContain("AURA");
    expect(output).toContain("© Satori Engineering Inc. 2026 Version abc1234");
    expect(stripVTControlCharacters(output)).toContain(
      "Project  project not created. run `aura init`",
    );
    expect(stripVTControlCharacters(output)).toContain("Account  not signed in");
    expect(stripVTControlCharacters(output)).toContain("Try this next:\n  aura login");
    expect(stripVTControlCharacters(output)).not.toContain("Try this next:\n  aura init");
  });
});
