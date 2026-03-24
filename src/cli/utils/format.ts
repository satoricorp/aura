import {
  getChildSections,
  getRootSections,
  summarizeAnnotation,
  type AuraDocument,
  type AuraSection,
} from "../../core/aura-md";

export function formatHelp(): string {
  return [
    "Usage: aura <command>",
    "",
    "Commands:",
    "  generate Generate agent source from aura.md",
    "  init    Create aura.config.ts and aura.md in the current directory",
    "  login   Sign in with Google and save a local Aura session",
    "  list    Show the agents currently defined in aura.md",
    "  logout  Revoke the saved Aura session on this machine",
    "  version Print the current Aura version",
    "  whoami  Show the current signed-in Aura user",
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
