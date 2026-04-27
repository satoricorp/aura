import type { CapturedToolCall } from "./types";

export type ToolSteeringDecision =
  | { action: "allow" }
  | { action: "warn"; message: string }
  | { action: "correct"; prompt: string; reason: string };

export function evaluateToolSteering(input: {
  originalTask: string;
  toolCalls: CapturedToolCall[];
}): ToolSteeringDecision {
  for (const call of input.toolCalls) {
    const command = extractCommand(call.input);
    if (command && isDangerousCommand(command)) {
      return {
        action: "correct",
        reason: `${call.tool_name} includes a destructive command.`,
        prompt: `Pause before running \`${command}\`. Explain why it is needed and ask for explicit confirmation before continuing.`,
      };
    }

    for (const filePath of extractFilePaths(call.input)) {
      if (isSensitivePath(filePath)) {
        return {
          action: "correct",
          reason: `${call.tool_name} targets a sensitive file.`,
          prompt: `Pause before modifying \`${filePath}\`. Explain the intended change and ask for explicit confirmation.`,
        };
      }
    }
  }

  const drift = findScopeDrift(input.originalTask, input.toolCalls);
  if (drift) {
    return {
      action: "warn",
      message: `Tool call touches \`${drift}\`, which may be outside the requested scope.`,
    };
  }

  return { action: "allow" };
}

function extractCommand(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  const command = input.command ?? input.cmd;
  return typeof command === "string" ? command : null;
}

function isDangerousCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    /\brm\s+-[^&|;]*r[^&|;]*f\b/.test(normalized) ||
    normalized.includes("git reset --hard") ||
    normalized.includes("push --force") ||
    (normalized.includes("curl ") && normalized.includes("| sh"))
  );
}

function extractFilePaths(input: unknown): string[] {
  const paths = new Set<string>();
  collectFilePaths(input, paths);
  return [...paths];
}

function collectFilePaths(value: unknown, paths: Set<string>): void {
  if (typeof value === "string") {
    if (looksLikePath(value)) {
      paths.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectFilePaths(item, paths);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (isPathKey(key) && typeof nestedValue === "string") {
      paths.add(nestedValue);
    } else {
      collectFilePaths(nestedValue, paths);
    }
  }
}

function findScopeDrift(originalTask: string, toolCalls: CapturedToolCall[]): string | null {
  const taskPath = extractMentionedPath(originalTask);
  if (!taskPath) {
    return null;
  }

  for (const call of toolCalls) {
    for (const filePath of extractFilePaths(call.input)) {
      if (!sameFileReference(taskPath, filePath)) {
        return filePath;
      }
    }
  }

  return null;
}

function extractMentionedPath(task: string): string | null {
  const match =
    /(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|mdx|css|html|yml|yaml)/i.exec(
      task,
    );
  return match?.[0] ?? null;
}

function sameFileReference(taskPath: string, toolPath: string): boolean {
  return normalizePath(taskPath) === normalizePath(toolPath);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/^.*\//, "").toLowerCase();
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    normalized.endsWith(".env") ||
    normalized.includes("/.env") ||
    normalized.includes("credentials") ||
    normalized.includes("secret")
  );
}

function isPathKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "path" || normalized.endsWith("_path") || normalized.includes("file");
}

function looksLikePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /^[\w.-]+\/[\w./-]+$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
