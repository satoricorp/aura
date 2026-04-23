import type { PostHogProperties } from "./posthog";

export type TrackedCommandName = "login" | "logout" | "whoami" | "version";

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
  return {
    authenticated: input.authenticated,
    cli_version: input.cliVersion,
    command: input.command,
    duration_ms: input.durationMs,
    platform: input.platform,
    success: input.success,
  };
}
