#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { runGenerate } from "./commands/generate";
import { runInit } from "./commands/init";
import { runList } from "./commands/list";
import { formatCurrentAuth } from "./commands/whoami";
import { formatHelp } from "./utils/format";
import { createAuthService, type CreateAuthServiceOptions } from "../core/auth/service";
import { loadAuraEnv } from "../core/env";
import { readAuraVersion } from "../core/package";
import { checkForAuraUpdates } from "../core/version-check";
import type { AuthService } from "../core/auth/types";

type CommandName = "generate" | "init" | "list" | "logout" | "whoami" | "version";
type HandlerCommand = "generate" | "init" | "list";
type ResolvedAction =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "command"; command: CommandName; args: string[] };
const COMMAND_NAMES: CommandName[] = ["generate", "init", "list", "logout", "whoami", "version"];

export interface MainDeps {
  authService?: AuthService;
  authServiceOptions?: CreateAuthServiceOptions;
  checkForUpdates?: typeof checkForAuraUpdates;
  createAuthService?: typeof createAuthService;
  loadEnv?: typeof loadAuraEnv;
  readVersion?: typeof readAuraVersion;
}

const handlers: Record<HandlerCommand, (args: string[], cwd: string) => Promise<void>> = {
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
  const createAuthServiceFromDeps = deps.createAuthService ?? createAuthService;
  const readVersion = deps.readVersion ?? readAuraVersion;

  await loadEnv(cwd);

  const authService = deps.authService ?? createAuthServiceFromDeps(deps.authServiceOptions);
  const action = resolveAction(command, args);

  if (action.kind === "command" && action.command === "logout") {
    const removed = await authService.logout();
    if (!removed) {
      p.log.warn("No saved Aura login was found on this system.");
      return;
    }

    p.log.success("Signed out and removed the saved local session.");
    return;
  }

  const status = await authService.getStatus();
  if (!status.authenticated) {
    const authState = await authService.ensureAuthenticated();
    p.log.success(`Signed in as ${authState.user.email}.`);
    console.log(formatRerunMessage(action));
    return;
  }

  await authService.ensureAuthenticated();

  const update = await checkForUpdates();
  if (update) {
    p.log.warn(
      `Aura ${update.latestVersion} is available (current ${update.currentVersion}). Set AURA_NO_UPDATES=1 to suppress this check.`,
    );
  }

  if (action.kind === "help") {
    console.log(formatHelp());
    return;
  }

  if (action.kind === "version" || action.command === "version") {
    console.log((await readVersion()) ?? "unknown");
    return;
  }

  if (action.command === "whoami") {
    console.log(await formatCurrentAuth(authService));
    return;
  }

  if (isHandlerCommand(action.command)) {
    await handlers[action.command](action.args, cwd);
    return;
  }

  throw new Error(`Unsupported command "${action.command}".`);
}

function resolveAction(command: string | undefined, args: string[]): ResolvedAction {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help" };
  }

  if (command === "--version" || command === "-v") {
    return { kind: "version" };
  }

  if (!isCommandName(command)) {
    throw new Error(`Unknown command "${command}".\n\n${formatHelp()}`);
  }

  return {
    kind: "command",
    command,
    args,
  };
}

function isCommandName(value: string): value is CommandName {
  return COMMAND_NAMES.includes(value as CommandName);
}

function isHandlerCommand(value: CommandName): value is HandlerCommand {
  return value === "generate" || value === "init" || value === "list";
}

function formatRerunMessage(action: ResolvedAction): string {
  if (action.kind === "help") {
    return "Run `aura` again for the help menu.";
  }

  if (action.kind === "version") {
    return "Run `aura --version` again.";
  }

  const suffix = [action.command, ...action.args].join(" ");
  return `Run \`aura ${suffix}\` again.`;
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
