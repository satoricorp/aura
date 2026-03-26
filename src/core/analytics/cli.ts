import type { PostHogProperties } from "./posthog";
import { parseGenerateOptions } from "../generate";

export type TrackedCommandName = "generate" | "init" | "list" | "login" | "logout" | "whoami" | "version";

export interface CommandAnalyticsInput {
  authenticated: boolean;
  args: string[];
  cliVersion: string;
  command: TrackedCommandName;
  durationMs: number;
  platform: string;
  success: boolean;
}

export function buildCommandAnalyticsProperties(input: CommandAnalyticsInput): PostHogProperties {
  const properties: PostHogProperties = {
    authenticated: input.authenticated,
    cli_version: input.cliVersion,
    command: input.command,
    duration_ms: input.durationMs,
    platform: input.platform,
    success: input.success,
  };

  if (input.command !== "generate") {
    return properties;
  }

  return {
    ...properties,
    ...parseGenerateAnalyticsArgs(input.args),
  };
}

export function parseGenerateAnalyticsArgs(args: string[]): {
  dry_run: boolean;
  has_target_arg: boolean;
  surface?: string;
} {
  try {
    const options = parseGenerateOptions(args);
    return {
      dry_run: options.dryRun,
      has_target_arg: Boolean(options.agent),
      surface: options.surface,
    };
  } catch {
    return {
      dry_run: args.includes("--dry-run"),
      has_target_arg: args.some((value) => !value.startsWith("-")),
    };
  }
}
