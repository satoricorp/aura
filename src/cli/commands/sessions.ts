import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionLogEntry, Verdict } from "../../core/proxy/types";

interface SessionRecord {
  diagnostic: boolean;
  fileName: string;
  requestId: string;
  status: Verdict["status"] | "NO_VERDICT";
  summary: string;
  ts: string;
  verdict?: Verdict;
}

type SlashTopic = "discrepancies" | "next" | "risks";

export async function formatSessions(logDir: string): Promise<string> {
  const sessions = await readSessions(logDir);
  if (sessions.length === 0) {
    return "No Aura sessions found.";
  }

  return ["Recent Aura sessions", "", ...sessions.map(formatSessionRow)].join("\n");
}

export async function formatSlash(args: string[], logDir: string): Promise<string> {
  const { requestId, topic } = parseSlashArgs(args);
  const sessions = await readSessions(logDir);
  const session = requestId
    ? sessions.find((entry) => entry.requestId === requestId)
    : sessions.find((entry) => entry.verdict);

  if (!session?.verdict) {
    return requestId
      ? `No Aura verdict found for session ${requestId}.`
      : "No Aura verdict found. Run a Claude Code task through Aura first.";
  }

  if (topic === "discrepancies") {
    return formatSlashList({
      empty: `Aura found no discrepancies in ${formatSessionScope(requestId)}.`,
      heading: `Review Aura's discrepancies for ${formatSessionScope(requestId)}.`,
      items: session.verdict.claimed_vs_actual,
      session,
    });
  }

  if (topic === "risks") {
    return formatSlashList({
      empty: `Aura found no risks in ${formatSessionScope(requestId)}.`,
      heading: `Review Aura's risks for ${formatSessionScope(requestId)}.`,
      items: session.verdict.risks,
      session,
    });
  }

  return [
    `Continue from Aura's suggested next step for ${formatSessionScope(requestId)}.`,
    "",
    formatSessionContext(session),
    "",
    `Next step: ${session.verdict.next_step}`,
  ].join("\n");
}

async function readSessions(logDir: string): Promise<SessionRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return [];
  }

  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort()
      .reverse()
      .map((entry) => readSession(path.join(logDir, entry), entry)),
  );

  return sessions.filter((entry): entry is SessionRecord => entry !== null && !entry.diagnostic);
}

async function readSession(filePath: string, fileName: string): Promise<SessionRecord | null> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  const entries = lines.map(parseJson).filter(isSessionLogEntry);
  const verdict = findLastVerdict(entries);
  const request = entries.find((entry) => entry.type === "request");
  const sessionEnd = [...entries].reverse().find((entry) => entry.type === "session_end");
  const ts = verdict?.entry.ts ?? sessionEnd?.ts ?? entries[0]?.ts ?? "";
  const requestId = extractRequestId(sessionEnd?.data) ?? extractRequestIdFromFileName(fileName);

  return {
    diagnostic: isAuraDiagnosticRequest(request?.data),
    fileName,
    requestId,
    status: verdict?.verdict.status ?? "NO_VERDICT",
    summary: verdict?.verdict.summary ?? "No verdict generated",
    ts,
    verdict: verdict?.verdict,
  };
}

function isAuraDiagnosticRequest(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const task = extractOriginalTask(value).trim().toLowerCase();
  return (
    task.startsWith("/aura-") ||
    task.includes("`aura slash discrepancies`") ||
    task.includes("`aura slash risks`") ||
    task.includes("`aura slash next`")
  );
}

function findLastVerdict(
  entries: SessionLogEntry[],
): { entry: SessionLogEntry; verdict: Verdict } | null {
  for (const entry of [...entries].reverse()) {
    if (entry.type === "verdict" && isVerdict(entry.data)) {
      return { entry, verdict: entry.data };
    }
  }

  return null;
}

function parseSlashArgs(args: string[]): { requestId?: string; topic: SlashTopic } {
  const [topic, requestId, ...rest] = args;
  if (rest.length > 0 || !isSlashTopic(topic)) {
    throw new Error('Usage: aura slash <discrepancies|risks|next> [request-id]');
  }

  return { requestId, topic };
}

function isSlashTopic(value: string | undefined): value is SlashTopic {
  return value === "discrepancies" || value === "risks" || value === "next";
}

function formatSessionRow(session: SessionRecord): string {
  return `${session.ts}  ${session.requestId.padEnd(12)}  ${session.status.padEnd(10)}  ${session.summary}`;
}

function formatSessionScope(requestId: string | undefined): string {
  return requestId ? `session ${requestId}` : "the latest session";
}

function formatSlashList(input: {
  empty: string;
  heading: string;
  items: string[];
  session: SessionRecord;
}): string {
  return [
    input.heading,
    "",
    formatSessionContext(input.session),
    "",
    ...(input.items.length > 0 ? input.items.map((item) => `- ${item}`) : [input.empty]),
  ].join("\n");
}

function formatSessionContext(session: SessionRecord): string {
  return [
    `Session: ${session.requestId}`,
    `Status: ${session.status}`,
    `Summary: ${session.summary}`,
  ].join("\n");
}

function extractRequestId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.request_id !== "string") {
    return undefined;
  }

  return value.request_id;
}

function extractRequestIdFromFileName(fileName: string): string {
  const match = /-(req_[^.]+)\.jsonl$/.exec(fileName);
  return match?.[1] ?? fileName.replace(/\.jsonl$/, "");
}

function extractOriginalTask(requestBody: Record<string, unknown>): string {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const firstUser = messages.find((message) => isRecord(message) && message.role === "user");

  if (!isRecord(firstUser)) {
    return "";
  }

  return stringifyContent(firstUser.content);
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }

      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isSessionLogEntry(value: unknown): value is SessionLogEntry {
  return (
    isRecord(value) &&
    typeof value.ts === "string" &&
    typeof value.type === "string" &&
    "data" in value
  );
}

function isVerdict(value: unknown): value is Verdict {
  return (
    isRecord(value) &&
    (value.status === "APPROVED" || value.status === "REVIEW" || value.status === "STOP") &&
    typeof value.summary === "string" &&
    typeof value.task_understanding === "string" &&
    Array.isArray(value.changes) &&
    Array.isArray(value.risks) &&
    Array.isArray(value.claimed_vs_actual) &&
    typeof value.next_step === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
