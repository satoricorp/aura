import { styleText } from "node:util";
import {
  getChildSections,
  getRootSections,
  summarizeAnnotation,
  type AuraDocument,
  type AuraSection,
} from "../../core/aura-md";

interface HelpCommand {
  command: string;
  description: string;
}

export interface HomeScreenState {
  cliVersion: string;
  hasAuraFile: boolean;
  hasConfigFile: boolean;
  authenticated: boolean;
  email?: string;
  needsRefresh: boolean;
}

const START_COMMANDS: HelpCommand[] = [
  {
    command: "aura init",
    description: "create starter files",
  },
  {
    command: "aura generate",
    description: "generate agent code from aura.md",
  },
  {
    command: "aura list",
    description: "inspect the agents in aura.md",
  },
];

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

const ALL_COMMANDS = [...START_COMMANDS, ...ACCOUNT_COMMANDS, ...UTILITY_COMMANDS];

export function formatUsage(): string {
  return [
    "Usage: aura <command>",
    "",
    "Commands:",
    ...formatCommandRows(ALL_COMMANDS),
  ].join("\n");
}

export function formatHomeScreen(state: HomeScreenState): string {
  const nextSteps = getSuggestedNextSteps(state);

  return [
    "AURA",
    `© Satori Engineering Inc. 2026 Version ${state.cliVersion}`,
    "",
    "Build multi-agent CLIs from aura.md",
    "Usage: aura <command>",
    "",
    formatStatusLine("Project", formatProjectStatus(state)),
    formatStatusLine("Account", formatAccountStatus(state)),
    "",
    "Start",
    ...formatCommandRows(START_COMMANDS),
    "",
    "Account",
    ...formatCommandRows(ACCOUNT_COMMANDS),
    "",
    "More",
    ...formatCommandRows(UTILITY_COMMANDS),
    ...formatNextSteps(nextSteps),
  ].join("\n");
}

/**
 * Renders the current `aura.md` section tree as a human-scannable CLI summary.
 *
 * Top-level orchestrators are listed first, then nested sections are rendered
 * as a tree. Counts come from annotation summaries when present, with child
 * sections used as the fallback signal for subagent display.
 */
export function formatAgentList(document: AuraDocument): string {
  const roots = getRootSections(document);
  if (roots.length === 0) {
    return "No agents found in aura.md.";
  }

  return roots
    .flatMap((section, index) =>
      formatSection(document, section, "", index === roots.length - 1, true),
    )
    .join("\n");
}

function formatSection(
  document: AuraDocument,
  section: AuraSection,
  prefix: string,
  isLast: boolean,
  isRoot = false,
): string[] {
  const children = getChildSections(document, section.slug);
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const nextPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
  const line = `${prefix}${connector}${formatSectionSummary(section, children.length)}`;

  return [
    line,
    ...children.flatMap((child, index) =>
      formatSection(document, child, nextPrefix, index === children.length - 1),
    ),
  ];
}

function formatSectionSummary(section: AuraSection, childCount: number): string {
  const summary = summarizeAnnotation(section.annotation?.value);
  const status = section.annotation ? "annotated" : "described";
  const parts = [formatCount(summary.tools, "tool"), formatCount(summary.endpoints, "endpoint")];

  if (section.level === 2 || childCount > 0 || summary.subagents > 0) {
    parts.push(formatCount(summary.subagents || childCount, "subagent"));
  }

  return `${section.slug.padEnd(18)} ${status.padEnd(10)} ${parts.join(" · ")}`;
}

function formatCount(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function formatCommandRows(commands: HelpCommand[]): string[] {
  const longest = Math.max(...commands.map((entry) => entry.command.length));
  return commands.map(
    (entry) => `  ${entry.command.padEnd(longest)}  ${entry.description}`,
  );
}

function formatPresence(value: boolean): string {
  return value ? "found" : "missing";
}

function formatProjectStatus(state: HomeScreenState): string {
  if (!state.hasAuraFile && !state.hasConfigFile) {
    return styleText("red", "project not created. run `aura init`");
  }

  return [`aura.md ${formatPresence(state.hasAuraFile)}`, `aura.config.ts ${formatPresence(state.hasConfigFile)}`].join(
    " • ",
  );
}

function formatStatusLine(label: string, value: string): string {
  return `${label.padEnd(8)} ${value}`;
}

function formatAccountStatus(state: HomeScreenState): string {
  if (!state.authenticated) {
    return "not signed in";
  }

  return state.email ? `signed in as ${state.email}` : "signed in";
}

function getSuggestedNextSteps(state: HomeScreenState): string[] {
  const nextSteps: string[] = [];

  if (state.hasAuraFile && state.hasConfigFile) {
    nextSteps.push("aura generate");
    nextSteps.push("aura list");
  }

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
