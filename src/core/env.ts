import path from "node:path";
import { pathExists, readText } from "./utils/fs";

export async function loadAuraEnv(cwd = process.cwd()): Promise<void> {
  const existingKeys = new Set(Object.keys(process.env));

  for (const fileName of [".env", ".env.local"]) {
    const envPath = path.join(cwd, fileName);
    if (!(await pathExists(envPath))) {
      continue;
    }

    const raw = await readText(envPath);
    for (const [key, value] of parseDotEnv(raw)) {
      if (existingKeys.has(key)) {
        continue;
      }

      process.env[key] = value;
    }
  }
}

export function parseDotEnv(raw: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!key) {
      continue;
    }

    const rawValue = normalized.slice(equalsIndex + 1).trim();
    entries.set(key, parseEnvValue(rawValue));
  }

  return entries;
}

function parseEnvValue(rawValue: string): string {
  if (!rawValue) {
    return "";
  }

  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    const unwrapped = rawValue.slice(1, -1);
    return rawValue.startsWith('"') ? unwrapped.replace(/\\n/g, "\n") : unwrapped;
  }

  const commentIndex = rawValue.indexOf(" #");
  return commentIndex >= 0 ? rawValue.slice(0, commentIndex).trimEnd() : rawValue;
}
