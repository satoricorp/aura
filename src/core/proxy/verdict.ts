import type { IncomingHttpHeaders } from "node:http";
import { renderVerdict, renderVerdictUnavailable } from "./render";
import type { SessionSummary, Verdict } from "./types";

const SYSTEM_PROMPT = `You are Aura, a code review assistant that evaluates a coding agent's work
against its assigned task. You will be given the original task, the agent's
tool calls, and the agent's final message. Produce a structured verdict.

Be specific. Reference actual file paths and changes. Flag scope drift
explicitly: did the agent edit files outside what was implied by the task?
Flag fabrication: did the agent claim to do something the tool calls don't
support? Flag risk: are the changes likely to break something?

Be concise. The verdict will be displayed in a terminal in <30 lines.
Do not pad. Do not hedge. If everything looks fine, say so plainly.

Respond with JSON only, no preamble, matching this schema:
{
  "status": "APPROVED" | "REVIEW" | "STOP",
  "summary": "one-line summary, max 80 chars",
  "task_understanding": "one-line restatement of what was asked",
  "changes": [{"path": "string", "action": "created" | "modified" | "deleted", "note": "one-line description"}],
  "risks": ["one-line risk", ...],
  "claimed_vs_actual": ["one-line discrepancy", ...],
  "next_step": "one-line suggestion"
}

Status definitions:
- APPROVED: in scope, no detected risks, ready to commit
- REVIEW: in scope but has risks worth checking before commit
- STOP: out of scope, fabricated work, or high risk — do not commit without investigation`;

export interface GenerateVerdictOptions {
  headers: IncomingHttpHeaders;
  model: string;
  summary: SessionSummary;
  upstreamOrigin: string;
}

export async function generateVerdict(options: GenerateVerdictOptions): Promise<Verdict> {
  const response = await fetch(new URL("/v1/messages", options.upstreamOrigin), {
    body: JSON.stringify({
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: buildVerdictUserMessage(options.summary),
        },
      ],
      model: options.model,
      stream: false,
      system: SYSTEM_PROMPT,
      temperature: 0.2,
    }),
    headers: buildVerdictHeaders(options.headers),
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Anthropic verdict call failed with ${response.status}`);
  }

  const parsed = (await response.json()) as unknown;
  const text = extractResponseText(parsed);
  return parseVerdictJson(text);
}

export async function generateAndPrintVerdict(
  options: GenerateVerdictOptions & {
    appendVerdict: (verdict: Verdict | { error: string }) => Promise<void>;
    stderr?: Pick<NodeJS.WriteStream, "write">;
  },
): Promise<string> {
  const stderr = options.stderr ?? process.stderr;

  try {
    const verdict = await generateVerdict(options);
    await options.appendVerdict(verdict);
    const rendered = renderVerdict(verdict);
    stderr.write(`${rendered}\n`);
    return rendered;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.appendVerdict({ error: message });
    const rendered = renderVerdictUnavailable(message, options.summary.sessionLogPath);
    stderr.write(`${rendered}\n`);
    return rendered;
  }
}

export function buildVerdictUserMessage(summary: SessionSummary): string {
  const toolCalls = summary.toolCalls.length
    ? summary.toolCalls
        .map((call, index) => `${index + 1}. ${call.tool_name}(${summarizeInput(call.summary)})`)
        .join("\n")
    : "(none)";
  const filesTouched = summary.filesTouched.length
    ? summary.filesTouched
        .map((change) => `${change.action} ${change.path} - ${change.note}`)
        .join("\n")
    : "(none)";

  return `ORIGINAL TASK:
${summary.originalTask}

AGENT'S TOOL CALLS:
${toolCalls}

AGENT'S FINAL MESSAGE:
${summary.finalAssistantText}

FILES TOUCHED (extracted from tool calls):
${filesTouched}

Produce the verdict JSON.`;
}

function buildVerdictHeaders(headers: IncomingHttpHeaders): Headers {
  const verdictHeaders = new Headers({
    "content-type": "application/json",
  });
  const apiKey = firstHeader(headers["x-api-key"]);
  const auth = firstHeader(headers.authorization);
  const version = firstHeader(headers["anthropic-version"]) ?? "2023-06-01";
  const beta = firstHeader(headers["anthropic-beta"]);

  if (apiKey) {
    verdictHeaders.set("x-api-key", apiKey);
  }

  if (auth) {
    verdictHeaders.set("authorization", auth);
  }

  verdictHeaders.set("anthropic-version", version);
  if (beta) {
    verdictHeaders.set("anthropic-beta", beta);
  }

  return verdictHeaders;
}

function extractResponseText(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.content)) {
    throw new Error("Verdict response did not include content.");
  }

  return response.content
    .map((block) => {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }

      return "";
    })
    .join("")
    .trim();
}

function parseVerdictJson(raw: string): Verdict {
  const json = extractJsonObject(raw);
  const parsed = JSON.parse(json) as unknown;
  if (!isVerdict(parsed)) {
    throw new Error("Verdict response did not match the expected schema.");
  }

  return parsed;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
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

function summarizeInput(summary: string): string {
  return summary.replace(/^[^(]+ ?/, "");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
