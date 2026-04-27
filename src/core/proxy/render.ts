import { styleText } from "node:util";
import type { Verdict } from "./types";

const WIDTH = 60;
const CONTENT_WIDTH = 56;
const BORDER = "─────────────────────────────────────";

export function renderVerdict(verdict: Verdict): string {
  const counts = countChanges(verdict);
  const lines = [
    `─── AURA ${BORDER}`,
    `${statusIcon(verdict.status)} ${verdict.status} - ${verdict.summary}`,
    "",
    `Task:        ${verdict.task_understanding}`,
    `Changes:     ${verdict.changes.length} files (${counts.created} new, ${counts.modified} modified, ${counts.deleted} deleted)`,
    ...verdict.changes.map(
      (change) => `  ${actionGlyph(change.action)} ${change.path} - ${change.note}`,
    ),
    ...section("Risks:", verdict.risks),
    ...section("Discrepancies:", verdict.claimed_vs_actual),
    `Next: ${verdict.next_step}`,
    BORDER,
  ];

  return lines.map(truncateLine).join("\n");
}

export function renderVerdictUnavailable(error: string, sessionLogPath: string): string {
  return [
    `─── AURA ${BORDER}`,
    `⚠ Verdict unavailable: ${error}`,
    `   Session log: ${sessionLogPath}`,
    BORDER,
  ]
    .map(truncateLine)
    .join("\n");
}

export function renderVerdictJsonLine(input: {
  color?: boolean;
  injected: boolean;
  model: string;
  requestId: string;
  verdict: Verdict;
}): string {
  return renderJsonLine(
    {
      type: "aura_verdict",
      model: input.model,
      request_id: input.requestId,
      injected: input.injected,
      ...input.verdict,
    },
    input.color,
  );
}

export function renderVerdictUnavailableJsonLine(input: {
  color?: boolean;
  error: string;
  injected: boolean;
  model: string;
  requestId: string;
  sessionLogPath: string;
}): string {
  return renderJsonLine(
    {
      type: "aura_verdict_unavailable",
      model: input.model,
      request_id: input.requestId,
      injected: input.injected,
      error: input.error,
      session_log_path: input.sessionLogPath,
    },
    input.color,
  );
}

export function renderAssistantVerdict(verdict: Verdict): string {
  return [
    `Aura: ${verdict.status} - ${verdict.summary}`,
    `Task: ${verdict.task_understanding}`,
    ...assistantChanges(verdict),
    ...assistantSection("Risks", verdict.risks),
    ...assistantSection("Discrepancies", verdict.claimed_vs_actual),
    `Next: ${verdict.next_step}`,
  ].join("\n");
}

export function renderAssistantVerdictUnavailable(error: string, sessionLogPath: string): string {
  return [`Aura: Verdict unavailable - ${error}`, `Session log: ${sessionLogPath}`].join("\n");
}

export function renderContinuationPrompt(verdict: Verdict): string {
  const paths = verdict.changes.map((change) => change.path);
  const files = paths.length > 0 ? paths.join(", ") : "none";

  return [
    "Continue from Aura's review:",
    verdict.next_step,
    "",
    "Context:",
    `- Status: ${verdict.status}`,
    `- Summary: ${verdict.summary}`,
    `- Files: ${files}`,
  ].join("\n");
}

export function renderSteeringPrompt(input: {
  message: string;
  reason?: string;
  task: string;
}): string {
  return [
    "Continue with Aura's steering:",
    input.message,
    "",
    "Context:",
    `- Task: ${input.task || "unknown"}`,
    ...(input.reason ? [`- Reason: ${input.reason}`] : []),
  ].join("\n");
}

function section(title: string, values: string[]): string[] {
  if (values.length === 0) {
    return [];
  }

  return ["", title, ...values.map((value) => `  • ${value}`)];
}

function assistantChanges(verdict: Verdict): string[] {
  if (verdict.changes.length === 0) {
    return ["Changes: none"];
  }

  return [
    "Changes:",
    ...verdict.changes.map((change) => `- ${change.action} ${change.path}: ${change.note}`),
  ];
}

function assistantSection(title: string, values: string[]): string[] {
  if (values.length === 0) {
    return [];
  }

  return [title + ":", ...values.map((value) => `- ${value}`)];
}

function renderJsonLine(value: unknown, color = false): string {
  if (!color) {
    return JSON.stringify(value);
  }

  return renderHighlightedJson(value);
}

function renderHighlightedJson(value: unknown, path: string[] = []): string {
  if (typeof value === "string") {
    return colorJsonString(value, path);
  }

  if (typeof value === "boolean") {
    return styleText(value ? "green" : "yellow", String(value));
  }

  if (typeof value === "number") {
    return styleText("yellow", String(value));
  }

  if (value === null) {
    return styleText("gray", "null");
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => renderHighlightedJson(entry, path)).join(",")}]`;
  }

  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, entry]) => {
        const renderedKey = styleText("cyan", JSON.stringify(key));
        return `${renderedKey}:${renderHighlightedJson(entry, [...path, key])}`;
      })
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function colorJsonString(value: string, path: string[]): string {
  const key = path[path.length - 1];
  const json = JSON.stringify(value);

  if (key === "status") {
    return styleText(statusColor(value), json);
  }

  if (key === "type") {
    return styleText("blue", json);
  }

  if (key === "model") {
    return styleText("magenta", json);
  }

  if (key === "error") {
    return styleText("red", json);
  }

  return styleText("green", json);
}

function statusColor(status: string): "green" | "red" | "yellow" {
  if (status === "APPROVED") {
    return "green";
  }

  if (status === "STOP") {
    return "red";
  }

  return "yellow";
}

function statusIcon(status: Verdict["status"]): string {
  if (status === "APPROVED") {
    return styleText("green", "✓");
  }

  if (status === "STOP") {
    return styleText("red", "✗");
  }

  return styleText("yellow", "⚠");
}

function actionGlyph(action: string): string {
  if (action === "created") {
    return "+";
  }

  if (action === "deleted") {
    return "−";
  }

  return "~";
}

function countChanges(verdict: Verdict): { created: number; deleted: number; modified: number } {
  return {
    created: verdict.changes.filter((change) => change.action === "created").length,
    deleted: verdict.changes.filter((change) => change.action === "deleted").length,
    modified: verdict.changes.filter((change) => change.action === "modified").length,
  };
}

function truncateLine(line: string): string {
  if (line.length <= WIDTH) {
    return line;
  }

  return `${line.slice(0, CONTENT_WIDTH - 1)}…`;
}
