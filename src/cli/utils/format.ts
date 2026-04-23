import { styleText } from "node:util";

interface HelpCommand {
  command: string;
  description: string;
}

export interface HomeScreenState {
  cliVersion: string;
  authenticated: boolean;
  email?: string;
  needsRefresh: boolean;
}

const ACCOUNT_COMMANDS: HelpCommand[] = [
  {
    command: "aura login",
    description: "sign in on this machine",
  },
  {
    command: "aura whoami",
    description: "show the current session",
  },
  {
    command: "aura logout",
    description: "remove the saved session",
  },
];

const UTILITY_COMMANDS: HelpCommand[] = [
  {
    command: "aura version",
    description: "print the current version",
  },
];

const ALL_COMMANDS = [...ACCOUNT_COMMANDS, ...UTILITY_COMMANDS];

export function formatUsage(): string {
  return ["Usage: aura <command>", "", "Commands:", ...formatCommandRows(ALL_COMMANDS)].join("\n");
}

export function formatHomeScreen(state: HomeScreenState): string {
  const nextSteps = getSuggestedNextSteps(state);

  return [
    "AURA",
    `© Satori Engineering Inc. 2026 Version ${state.cliVersion}`,
    "",
    "Usage: aura <command>",
    "",
    formatStatusLine("Account", formatAccountStatus(state)),
    "",
    "Account",
    ...formatCommandRows(ACCOUNT_COMMANDS),
    "",
    "More",
    ...formatCommandRows(UTILITY_COMMANDS),
    ...formatNextSteps(nextSteps),
  ].join("\n");
}

function formatCommandRows(commands: HelpCommand[]): string[] {
  const longest = Math.max(...commands.map((entry) => entry.command.length));
  return commands.map(
    (entry) => `  ${entry.command.padEnd(longest)}  ${entry.description}`,
  );
}

function formatStatusLine(label: string, value: string): string {
  return `${label.padEnd(8)} ${value}`;
}

function formatAccountStatus(state: HomeScreenState): string {
  if (!state.authenticated) {
    return styleText("red", "not signed in");
  }

  return state.email ? `signed in as ${state.email}` : "signed in";
}

function getSuggestedNextSteps(state: HomeScreenState): string[] {
  const nextSteps: string[] = [];

  if (!state.authenticated) {
    nextSteps.push("aura login");
  }

  return nextSteps.slice(0, 3);
}

function formatNextSteps(nextSteps: string[]): string[] {
  if (nextSteps.length === 0) {
    return [];
  }

  return ["", "Try this next:", ...nextSteps.map((command) => `  ${command}`)];
}
