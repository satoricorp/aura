import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parsePort, type ProxyConfig } from "../../core/proxy/config";
import type { Verdict } from "../../core/proxy/types";

export interface InitResult {
  changed: boolean;
  configPath: string;
  snippet: string;
}

export async function installAnthropicBaseUrl(
  shell = process.env.SHELL ?? "",
  port = 8787,
  homeDirectory = homedir(),
): Promise<InitResult> {
  const snippet = formatAnthropicBaseUrlSnippet(shell, port);
  const configPath = resolveShellConfigPath(shell, homeDirectory);
  const existing = await readTextIfExists(configPath);

  if (existing.includes(snippet)) {
    return {
      changed: false,
      configPath,
      snippet,
    };
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(configPath, `${prefix}\n# Aura proxy\n${snippet}\n`, "utf8");

  return {
    changed: true,
    configPath,
    snippet,
  };
}

export function formatInitResult(result: InitResult): string {
  const action = result.changed ? "Updated" : "Already configured";
  return [
    "Aura proxy setup",
    "",
    `${action}: ${result.configPath}`,
    `  ${result.snippet}`,
    "",
    "Open a new terminal and run your coding agent.",
  ].join("\n");
}

export function formatInitInstructions(shell = process.env.SHELL ?? "", port = 8787): string {
  const snippet = formatAnthropicBaseUrlSnippet(shell, port);
  const target = shell.includes("fish")
    ? "~/.config/fish/config.fish"
    : shell.includes("bash")
      ? "~/.bashrc"
      : "~/.zshrc";

  return [
    "Aura proxy setup",
    "",
    `Add this to ${target}:`,
    `  ${snippet}`,
    "",
    "Then start Aura in a dedicated terminal:",
    "  aura start",
  ].join("\n");
}

function formatAnthropicBaseUrlSnippet(shell: string, port: number): string {
  const baseUrl = `http://localhost:${port}`;
  return shell.includes("fish")
    ? `set -gx ANTHROPIC_BASE_URL ${baseUrl}`
    : `export ANTHROPIC_BASE_URL=${baseUrl}`;
}

function resolveShellConfigPath(shell: string, homeDirectory: string): string {
  if (shell.includes("fish")) {
    return path.join(homeDirectory, ".config", "fish", "config.fish");
  }

  if (shell.includes("bash")) {
    return path.join(homeDirectory, ".bashrc");
  }

  return path.join(homeDirectory, ".zshrc");
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export function applyStartArgs(config: ProxyConfig, args: string[]): ProxyConfig {
  const next = { ...config };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--port") {
      throw new Error(`Unknown start option "${arg}".`);
    }

    const value = args[index + 1];
    if (!value) {
      throw new Error("Missing value for --port.");
    }

    next.port = parsePort(value);
    index += 1;
  }

  return next;
}

export async function formatStatus(logDir: string, limit = 10): Promise<string> {
  const verdicts = await readRecentVerdicts(logDir, limit);
  if (verdicts.length === 0) {
    return "No Aura verdicts found.";
  }

  return ["Recent Aura verdicts", "", ...verdicts.map(formatVerdictRow)].join("\n");
}

async function readRecentVerdicts(logDir: string, limit: number): Promise<RecentVerdict[]> {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return [];
  }

  const verdicts: RecentVerdict[] = [];
  for (const fileName of entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort()
    .reverse()) {
    const verdict = await readLastVerdict(path.join(logDir, fileName));
    if (verdict) {
      verdicts.push(verdict);
    }

    if (verdicts.length >= limit) {
      break;
    }
  }

  return verdicts;
}

async function readLastVerdict(filePath: string): Promise<RecentVerdict | null> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.trim().split(/\r?\n/).reverse();

  for (const line of lines) {
    const parsed = parseJson(line);
    if (!isRecord(parsed) || parsed.type !== "verdict" || !isRecord(parsed.data)) {
      continue;
    }

    const data = parsed.data;
    if (typeof data.status !== "string" || typeof data.summary !== "string") {
      continue;
    }

    return {
      status: data.status,
      summary: data.summary,
      ts: typeof parsed.ts === "string" ? parsed.ts : "",
    };
  }

  return null;
}

function formatVerdictRow(verdict: RecentVerdict): string {
  return `${verdict.ts}  ${verdict.status.padEnd(8)}  ${verdict.summary}`;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface RecentVerdict {
  status: Verdict["status"] | string;
  summary: string;
  ts: string;
}
