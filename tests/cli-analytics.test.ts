import { describe, expect, test } from "bun:test";
import {
  buildCommandAnalyticsProperties,
  parseGenerateAnalyticsArgs,
} from "../src/core/analytics/cli";

describe("buildCommandAnalyticsProperties", () => {
  test("includes only argv-derived generate metadata", () => {
    const properties = buildCommandAnalyticsProperties({
      authenticated: true,
      args: ["support-bot", "api", "--dry-run"],
      cliVersion: "1.2.3",
      command: "generate",
      durationMs: 42,
      platform: "darwin",
      success: true,
    });

    expect(properties).toEqual({
      authenticated: true,
      cli_version: "1.2.3",
      command: "generate",
      dry_run: true,
      duration_ms: 42,
      has_target_arg: true,
      platform: "darwin",
      success: true,
      surface: "api",
    });
  });

  test("falls back safely when generate args are invalid", () => {
    expect(parseGenerateAnalyticsArgs(["one", "two", "three"])).toEqual({
      dry_run: false,
      has_target_arg: true,
    });
  });
});
