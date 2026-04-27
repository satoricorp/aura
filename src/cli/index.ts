#!/usr/bin/env node

import * as p from "@clack/prompts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyStartArgs,
  formatInitResult,
  formatSlashCommandInstallResult,
  formatStatus,
  installAnthropicBaseUrl,
  installClaudeSlashCommands,
} from "./commands/proxy";
import { formatSessions, formatSlash } from "./commands/sessions";
import { formatCurrentAuth } from "./commands/whoami";
import { formatHomeScreen, formatUsage } from "./utils/format";
import { buildCommandAnalyticsProperties, type TrackedCommandName } from "../core/analytics/cli";
import { createPostHogClient, type PostHogClient } from "../core/analytics/posthog";
import { createAuthService, type CreateAuthServiceOptions } from "../core/auth/service";
import type { AuthService } from "../core/auth/types";
import { loadAuraEnv } from "../core/env";
import { readAuraVersion } from "../core/package";
import { loadProxyConfig } from "../core/proxy/config";
import { startProxyServer } from "../core/proxy/server";
import { checkForAuraUpdates } from "../core/version-check";

type CommandName =
  | "init"
  | "login"
  | "logout"
  | "sessions"
  | "slash"
  | "start"
  | "status"
  | "whoami"
  | "version";
const COMMAND_NAMES: CommandName[] = [
  "init",
  "login",
  "logout",
  "sessions",
  "slash",
  "start",
  "status",
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
  loadProxyConfig?: typeof loadProxyConfig;
  installClaudeSlashCommands?: typeof installClaudeSlashCommands;
  installAnthropicBaseUrl?: typeof installAnthropicBaseUrl;
  readVersion?: typeof readAuraVersion;
  startProxyServer?: typeof startProxyServer;
}

type Invocation =
  | {
      kind: "help";
    }
  | {
      kind: "version-flag";
    }
  | {
      kind: "command";
      args: string[];
      command: CommandName;
    };

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  deps: MainDeps = {},
): Promise<void> {
  const loadEnv = deps.loadEnv ?? loadAuraEnv;
  const checkForUpdates = deps.checkForUpdates ?? checkForAuraUpdates;
  const createAnalytics = deps.createAnalytics ?? createPostHogClient;
  const createAuthServiceFromDeps = deps.createAuthService ?? createAuthService;
  const installClaudeSlashCommandsFromDeps =
    deps.installClaudeSlashCommands ?? installClaudeSlashCommands;
  const installAnthropicBaseUrlFromDeps = deps.installAnthropicBaseUrl ?? installAnthropicBaseUrl;
  const loadProxyConfigFromDeps = deps.loadProxyConfig ?? loadProxyConfig;
  const readVersion = deps.readVersion ?? readAuraVersion;
  const startProxyServerFromDeps = deps.startProxyServer ?? startProxyServer;

  await loadEnv(cwd);
  const cliVersion = (await readVersion()) ?? "unknown";
  const invocation = resolveInvocation(argv);

  if (invocation.kind === "help") {
    const authService = deps.authService ?? createAuthServiceFromDeps(deps.authServiceOptions);
    console.log(await renderHomeScreen(cliVersion, authService));
    return;
  }

  if (invocation.kind === "version-flag") {
    console.log(cliVersion);
    return;
  }

  if (invocation.command === "init") {
    const config = loadProxyConfigFromDeps();
    const result = await installAnthropicBaseUrlFromDeps(process.env.SHELL, config.port);
    const slashCommands = await installClaudeSlashCommandsFromDeps();
    console.log(
      [formatInitResult(result), formatSlashCommandInstallResult(slashCommands)].join("\n\n"),
    );
    await startProxyServerFromDeps({
      config,
      stderr: process.stderr,
      stdout: process.stdout,
    });
    return;
  }

  if (invocation.command === "status") {
    const config = loadProxyConfigFromDeps();
    console.log(await formatStatus(config.logDir));
    return;
  }

  if (invocation.command === "sessions") {
    const config = loadProxyConfigFromDeps();
    console.log(await formatSessions(config.logDir));
    return;
  }

  if (invocation.command === "slash") {
    const config = loadProxyConfigFromDeps();
    console.log(await formatSlash(invocation.args, config.logDir));
    return;
  }

  if (invocation.command === "start") {
    const config = applyStartArgs(loadProxyConfigFromDeps(), invocation.args);
    const result = await installAnthropicBaseUrlFromDeps(process.env.SHELL, config.port);
    const slashCommands = await installClaudeSlashCommandsFromDeps();
    process.stderr.write(
      `${[formatInitResult(result), formatSlashCommandInstallResult(slashCommands)].join("\n\n")}\n`,
    );
    await startProxyServerFromDeps({
      config,
      stderr: process.stderr,
      stdout: process.stdout,
    });
    return;
  }

  const analytics = deps.analytics ?? createAnalytics();
  const authService = deps.authService ?? createAuthServiceFromDeps(deps.authServiceOptions);

  const startedAt = Date.now();
  let authenticated = false;
  let distinctId: string | undefined;

  if (invocation.command === "logout") {
    if (analytics.enabled) {
      const authStatus = await authService.getStatus();
      if (authStatus.authenticated && authStatus.authState) {
        authenticated = true;
        distinctId = authStatus.authState.user.id;
      }
    }
  } else {
    const authStatus = await authService.getStatus();
    if (authStatus.authenticated && authStatus.authState) {
      authenticated = true;
      distinctId = authStatus.authState.user.id;
    }
  }

  const { command, args } = invocation;

  const update = await checkForUpdates();
  if (update) {
    p.log.warn(
      `Aura ${update.latestVersion} is available (current ${update.currentVersion}). Set AURA_NO_UPDATES=1 to suppress this check.`,
    );
  }

  try {
    if (command === "login") {
      const authState = await authService.login();
      distinctId = authState.user.id;
      authenticated = true;
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

function resolveInvocation(argv: string[]): Invocation {
  const [command, ...args] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    return {
      kind: "help",
    };
  }

  if (command === "--version" || command === "-v") {
    return {
      kind: "version-flag",
    };
  }

  if (!isCommandName(command)) {
    throw new Error(`Unknown command "${command}".\n\n${formatUsage()}`);
  }

  return {
    kind: "command",
    args,
    command,
  };
}

function isCommandName(value: string): value is CommandName {
  return COMMAND_NAMES.includes(value as CommandName);
}

async function captureCommandOutcome(
  analytics: PostHogClient,
  input: {
    args: string[];
    authenticated: boolean;
    cliVersion: string;
    command: TrackedCommandName;
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

async function renderHomeScreen(cliVersion: string, authService: AuthService): Promise<string> {
  const authStatus = await authService.getStatus();

  return formatHomeScreen({
    cliVersion,
    authenticated: authStatus.authenticated,
    email: authStatus.authState?.user.email,
    needsRefresh: authStatus.needsRefresh,
  });
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
