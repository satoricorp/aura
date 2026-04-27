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

function section(title: string, values: string[]): string[] {
  if (values.length === 0) {
    return [];
  }

  return ["", title, ...values.map((value) => `  • ${value}`)];
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
