import { describe, expect, test } from "bun:test";
import { buildCommandAnalyticsProperties } from "../src/core/analytics/cli";

describe("buildCommandAnalyticsProperties", () => {
  test("includes standard CLI metadata", () => {
    const properties = buildCommandAnalyticsProperties({
      authenticated: true,
      args: [],
      cliVersion: "1.2.3",
      command: "whoami",
      durationMs: 42,
      platform: "darwin",
      success: true,
    });

    expect(properties).toEqual({
      authenticated: true,
      cli_version: "1.2.3",
      command: "whoami",
      duration_ms: 42,
      platform: "darwin",
      success: true,
    });
  });
});
