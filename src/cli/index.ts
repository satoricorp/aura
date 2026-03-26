#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { runGenerate } from "./commands/generate";
import { runInit } from "./commands/init";
import { runList } from "./commands/list";
import { formatCurrentAuth } from "./commands/whoami";
import { formatHelp } from "./utils/format";
import { buildCommandAnalyticsProperties } from "../core/analytics/cli";
import { createPostHogClient, type PostHogClient } from "../core/analytics/posthog";
import { createAuthService, type CreateAuthServiceOptions } from "../core/auth/service";
import type { AuthService, AuthStatus } from "../core/auth/types";
import { loadAuraEnv } from "../core/env";
import { readAuraVersion } from "../core/package";
import { checkForAuraUpdates } from "../core/version-check";

type CommandName = "generate" | "init" | "list" | "login" | "logout" | "whoami" | "version";
const COMMAND_NAMES: CommandName[] = [
  "generate",
  "init",
  "list",
  "login",
  "logout",
  "whoami",
  "version",
];

export interface MainDeps {
  analytics?: PostHogClient;
  authService?: AuthService;
  authServiceOptions?: CreateAuthServiceOptions;
  checkForUpdates?: typeof checkForAuraUpdates;
  createAnalytics?: typeof createPostHogClient;
  createAuthService?: typeof createAuthService;
  loadEnv?: typeof loadAuraEnv;
  readVersion?: typeof readAuraVersion;
}

const handlers: Record<"generate" | "init" | "list", (args: string[], cwd: string) => Promise<void>> = {
  generate: runGenerate,
  init: async (_args, cwd) => runInit(cwd),
  list: async (_args, cwd) => runList(cwd),
};

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  deps: MainDeps = {},
): Promise<void> {
  const [command, ...args] = argv;
  const loadEnv = deps.loadEnv ?? loadAuraEnv;
  const checkForUpdates = deps.checkForUpdates ?? checkForAuraUpdates;
  const createAnalytics = deps.createAnalytics ?? createPostHogClient;
  const createAuthServiceFromDeps = deps.createAuthService ?? createAuthService;
  const readVersion = deps.readVersion ?? readAuraVersion;

  await loadEnv(cwd);
  const cliVersion = (await readVersion()) ?? "unknown";
  const analytics = deps.analytics ?? createAnalytics();

  const authService = deps.authService ?? createAuthServiceFromDeps(deps.authServiceOptions);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(formatHelp());
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(cliVersion);
    return;
  }

  if (!isCommandName(command)) {
    throw new Error(`Unknown command "${command}".\n\n${formatHelp()}`);
  }

  const startedAt = Date.now();
  let authenticated = false;
  let distinctId: string | undefined;
  let utilityStatus: AuthStatus | undefined;

  if (!isUtilityCommand(command)) {
    const authState = await authService.ensureAuthenticated();
    authenticated = true;
    distinctId = authState.user.id;
  } else if (analytics.enabled && requiresStatusLookup(command)) {
    utilityStatus = await authService.getStatus();
    if (utilityStatus.authenticated && utilityStatus.authState) {
      authenticated = true;
      distinctId = utilityStatus.authState.user.id;
    }
  }

  const update = await checkForUpdates();
  if (update) {
    p.log.warn(
      `Aura ${update.latestVersion} is available (current ${update.currentVersion}). Set AURA_NO_UPDATES=1 to suppress this check.`,
    );
  }

  try {
    if (command === "login") {
      const authState = await authService.login();
      authenticated = true;
      distinctId = authState.user.id;
      p.log.success(`Signed in as ${authState.user.email}.`);
      await captureCommandOutcome(analytics, {
        args,
        authenticated,
        cliVersion,
        command,
        distinctId,
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return;
    }

    if (command === "logout") {
      const removed = await authService.logout();
      if (!removed) {
        p.log.warn("No saved Aura login was found on this system.");
        return;
      }

      if (distinctId) {
        await analytics.capture({
          distinctId,
          event: "user logged out",
          properties: {
            authenticated,
            cli_version: cliVersion,
            command,
            platform: process.platform,
          },
        });
      }

      p.log.success("Signed out and removed the saved local session.");
      await captureCommandOutcome(analytics, {
        args,
        authenticated,
        cliVersion,
        command,
        distinctId,
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return;
    }

    if (command === "whoami") {
      console.log(await formatCurrentAuth(authService));
      await captureCommandOutcome(analytics, {
        args,
        authenticated,
        cliVersion,
        command,
        distinctId,
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return;
    }

    if (command === "version") {
      console.log(cliVersion);
      await captureCommandOutcome(analytics, {
        args,
        authenticated,
        cliVersion,
        command,
        distinctId,
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return;
    }

    await handlers[command](args, cwd);
    await captureCommandOutcome(analytics, {
      args,
      authenticated,
      cliVersion,
      command,
      distinctId,
      durationMs: Date.now() - startedAt,
      success: true,
    });
  } catch (error) {
    await captureCommandOutcome(analytics, {
      args,
      authenticated,
      cliVersion,
      command,
      distinctId,
      durationMs: Date.now() - startedAt,
      success: false,
    });
    throw error;
  }
}

function isCommandName(value: string): value is CommandName {
  return COMMAND_NAMES.includes(value as CommandName);
}

function isUtilityCommand(value: CommandName): boolean {
  return value === "login" || value === "logout" || value === "whoami" || value === "version";
}

function requiresStatusLookup(value: CommandName): boolean {
  return value === "logout" || value === "whoami" || value === "version";
}

async function captureCommandOutcome(
  analytics: PostHogClient,
  input: {
    args: string[];
    authenticated: boolean;
    cliVersion: string;
    command: CommandName;
    distinctId?: string;
    durationMs: number;
    success: boolean;
  },
): Promise<void> {
  if (!input.distinctId) {
    return;
  }

  await analytics.capture({
    distinctId: input.distinctId,
    event: input.success ? "command completed" : "command failed",
    properties: buildCommandAnalyticsProperties({
      authenticated: input.authenticated,
      args: input.args,
      cliVersion: input.cliVersion,
      command: input.command,
      durationMs: input.durationMs,
      platform: process.platform,
      success: input.success,
    }),
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}
