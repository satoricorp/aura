#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { runInit } from "./commands/init";
import { runList } from "./commands/list";
import { formatHelp } from "./utils/format";
import { checkForAuraUpdates } from "../core/version-check";

type CommandName = "init" | "list";

const handlers: Record<CommandName, (cwd: string) => Promise<void>> = {
  init: runInit,
  list: runList,
};

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command] = argv;
  const update = await checkForAuraUpdates();
  if (update) {
    p.log.warn(
      `Aura ${update.latestVersion} is available (current ${update.currentVersion}). Set AURA_NO_UPDATES=1 to suppress this check.`,
    );
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(formatHelp());
    return;
  }

  if (!isCommandName(command)) {
    throw new Error(`Unknown command "${command}".\n\n${formatHelp()}`);
  }

  await handlers[command](cwd);
}

function isCommandName(value: string): value is CommandName {
  return value in handlers;
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
