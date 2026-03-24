import { readFile } from "node:fs/promises";

export interface LocalPackage {
  name: string;
  version: string;
}

export async function readLocalPackage(): Promise<LocalPackage | null> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    if (!parsed.name || !parsed.version) {
      return null;
    }

    return {
      name: parsed.name,
      version: parsed.version,
    };
  } catch {
    return null;
  }
}

export async function readAuraVersion(): Promise<string | null> {
  return (await readLocalPackage())?.version ?? null;
}
