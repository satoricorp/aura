import { toSlug } from "./slugs";
import { readText } from "./utils/fs";
import { resolveProjectPaths } from "./utils/paths";

export type ManagedBlockType = "annotation" | "metadata";

export interface ManagedBlock {
  type: ManagedBlockType;
  value: string;
  raw: string;
  start: number;
  end: number;
}

export interface AuraSection {
  title: string;
  slug: string;
  level: number;
  parentSlug?: string;
  headingStart: number;
  headingEnd: number;
  preludeStart: number;
  preludeEnd: number;
  description: string;
  annotation?: ManagedBlock;
  metadata?: ManagedBlock;
}

export interface AuraDocument {
  raw: string;
  sections: AuraSection[];
}

export interface AnnotationSummary {
  tools: number;
  endpoints: number;
  subagents: number;
}

interface HeadingMatch {
  level: number;
  title: string;
  start: number;
  lineEnd: number;
  contentStart: number;
}

const HEADING_REGEX = /^(#{1,6})[ \t]+(.+?)\s*$/gm;
const MANAGED_BLOCK_REGEX = /```(annotation|metadata)\r?\n([\s\S]*?)\r?\n```/g;

export async function loadAuraMarkdown(cwd = process.cwd()): Promise<AuraDocument> {
  const { auraFile } = resolveProjectPaths(cwd);
  const raw = await readText(auraFile);
  return parseAuraMarkdown(raw);
}

export function parseAuraMarkdown(raw: string): AuraDocument {
  const headings = matchHeadings(raw);
  const sections: AuraSection[] = [];
  const stack: AuraSection[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading.level < 2) {
      continue;
    }

    const nextHeading = headings[index + 1];
    const preludeEnd = nextHeading?.start ?? raw.length;
    const prelude = raw.slice(heading.contentStart, preludeEnd);
    const blocks = findManagedBlocks(prelude, heading.contentStart);

    while (stack.length > 0 && stack.at(-1)!.level >= heading.level) {
      stack.pop();
    }

    const parent = stack.at(-1);
    const section: AuraSection = {
      title: heading.title,
      slug: toSlug(heading.title),
      level: heading.level,
      parentSlug: parent?.slug,
      headingStart: heading.start,
      headingEnd: heading.lineEnd,
      preludeStart: heading.contentStart,
      preludeEnd,
      description: stripManagedBlocks(prelude),
      annotation: blocks.annotation,
      metadata: blocks.metadata,
    };

    sections.push(section);
    stack.push(section);
  }

  return { raw, sections };
}

export function getRootSections(document: AuraDocument): AuraSection[] {
  return document.sections.filter((section) => section.level === 2);
}

export function getChildSections(document: AuraDocument, parentSlug: string): AuraSection[] {
  return document.sections.filter((section) => section.parentSlug === parentSlug);
}

export function summarizeAnnotation(annotation?: string): AnnotationSummary {
  return {
    tools: countListEntries(annotation, "tools"),
    endpoints: countListEntries(annotation, "endpoints"),
    subagents: countListEntries(annotation, "subagents"),
  };
}

export function upsertManagedBlocks(
  document: AuraDocument,
  sectionSlug: string,
  nextBlocks: Partial<Record<ManagedBlockType, string | null>>,
): string {
  const section = document.sections.find((candidate) => candidate.slug === sectionSlug);
  if (!section) {
    throw new Error(`Unknown section "${sectionSlug}".`);
  }

  const merged: Partial<Record<ManagedBlockType, string | null>> = {
    annotation: section.annotation?.value ?? null,
    metadata: section.metadata?.value ?? null,
    ...nextBlocks,
  };

  const rendered = (["annotation", "metadata"] as const)
    .flatMap((type) => {
      const value = merged[type];
      return value == null ? [] : [renderManagedBlock(type, value)];
    })
    .join("\n\n");

  const existingBlocks = [section.annotation, section.metadata]
    .filter((block): block is ManagedBlock => Boolean(block))
    .sort((left, right) => left.start - right.start);

  if (existingBlocks.length === 0) {
    if (!rendered) {
      return document.raw;
    }

    const insertion = createManagedInsertion(document.raw, section, rendered);
    return (
      document.raw.slice(0, section.preludeEnd) + insertion + document.raw.slice(section.preludeEnd)
    );
  }

  const replacementStart = existingBlocks[0].start;
  const replacementEnd = existingBlocks.at(-1)!.end;

  return document.raw.slice(0, replacementStart) + rendered + document.raw.slice(replacementEnd);
}

function matchHeadings(raw: string): HeadingMatch[] {
  const matches: HeadingMatch[] = [];
  for (const match of raw.matchAll(HEADING_REGEX)) {
    const start = match.index ?? 0;
    const lineEnd = start + match[0].length;
    const contentStart = lineEnd + getLineBreakLength(raw, lineEnd);

    matches.push({
      level: match[1].length,
      title: match[2].trim(),
      start,
      lineEnd,
      contentStart,
    });
  }

  return matches;
}

function findManagedBlocks(
  prelude: string,
  baseOffset: number,
): Partial<Record<ManagedBlockType, ManagedBlock>> {
  const blocks: Partial<Record<ManagedBlockType, ManagedBlock>> = {};

  for (const match of prelude.matchAll(MANAGED_BLOCK_REGEX)) {
    const type = match[1] as ManagedBlockType;
    const start = baseOffset + (match.index ?? 0);
    const raw = match[0];

    blocks[type] = {
      type,
      value: match[2],
      raw,
      start,
      end: start + raw.length,
    };
  }

  return blocks;
}

function stripManagedBlocks(prelude: string): string {
  return prelude.replace(MANAGED_BLOCK_REGEX, "").trim();
}

function countListEntries(
  source: string | undefined,
  key: "tools" | "endpoints" | "subagents",
): number {
  if (!source) {
    return 0;
  }

  const lines = source.split(/\r?\n/);
  let inSection = false;
  let baseIndent = 0;
  let count = 0;

  for (const line of lines) {
    if (!inSection) {
      const match = line.match(new RegExp(`^(\\s*)${key}:\\s*$`));
      if (match) {
        inSection = true;
        baseIndent = match[1].length;
      }
      continue;
    }

    if (line.trim().length === 0) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) {
      break;
    }

    if (line.trimStart().startsWith("- ")) {
      count += 1;
    }
  }

  return count;
}

function renderManagedBlock(type: ManagedBlockType, value: string): string {
  return `\`\`\`${type}\n${value.trimEnd()}\n\`\`\``;
}

function createManagedInsertion(raw: string, section: AuraSection, rendered: string): string {
  const hasPrelude = section.preludeEnd > section.preludeStart;
  const prefix = hasPrelude ? determineLeadingSpacing(raw, section.preludeEnd) : "";
  const suffix = determineTrailingSpacing(raw, section.preludeEnd);
  return `${prefix}${rendered}${suffix}`;
}

function determineLeadingSpacing(raw: string, insertionPoint: number): string {
  if (raw.slice(Math.max(0, insertionPoint - 2), insertionPoint).endsWith("\n\n")) {
    return "";
  }

  if (raw.slice(Math.max(0, insertionPoint - 1), insertionPoint) === "\n") {
    return "\n";
  }

  return "\n\n";
}

function determineTrailingSpacing(raw: string, insertionPoint: number): string {
  const nextSlice = raw.slice(insertionPoint, insertionPoint + 2);
  if (nextSlice.startsWith("\n\n")) {
    return "";
  }

  if (nextSlice.startsWith("\n")) {
    return "\n";
  }

  return "\n\n";
}

function getLineBreakLength(raw: string, lineEnd: number): number {
  if (raw.slice(lineEnd, lineEnd + 2) === "\r\n") {
    return 2;
  }

  const nextCharacter = raw[lineEnd];
  return nextCharacter === "\n" || nextCharacter === "\r" ? 1 : 0;
}
