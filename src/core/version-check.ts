import { readFile } from "node:fs/promises";

export interface AuraUpdate {
  currentVersion: string;
  latestVersion: string;
}

export async function checkForAuraUpdates(): Promise<AuraUpdate | null> {
  if (process.env.AURA_NO_UPDATES === "1") {
    return null;
  }

  const localPackage = await readLocalPackage();
  if (!localPackage || localPackage.version === "0.0.0") {
    return null;
  }

  try {
    const response = await fetch(`https://registry.npmjs.org/${localPackage.name}/latest`, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(1500),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { version?: string };
    if (!payload.version || compareVersions(payload.version, localPackage.version) <= 0) {
      return null;
    }

    return {
      currentVersion: localPackage.version,
      latestVersion: payload.version,
    };
  } catch {
    return null;
  }
}

async function readLocalPackage(): Promise<{ name: string; version: string } | null> {
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

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}
