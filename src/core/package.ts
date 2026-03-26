import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalPackage {
  name: string;
  version: string;
}

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export async function readLocalPackage(rootPath = PACKAGE_ROOT): Promise<LocalPackage | null> {
  try {
    const raw = await readFile(path.join(rootPath, "package.json"), "utf8");
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

export async function readAuraVersion(rootPath = PACKAGE_ROOT): Promise<string | null> {
  return (await readGitHeadCommit(rootPath)) ?? (await readLocalPackage(rootPath))?.version ?? null;
}

async function readGitHeadCommit(rootPath: string): Promise<string | null> {
  try {
    const gitDir = await resolveGitDirectory(rootPath);
    if (!gitDir) {
      return null;
    }

    const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const refMatch = /^ref:\s*(.+)$/.exec(head);
    const commit = refMatch
      ? ((await readLooseRef(gitDir, refMatch[1])) ?? (await readPackedRef(gitDir, refMatch[1])))
      : head;

    if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) {
      return null;
    }

    return commit.slice(0, 7);
  } catch {
    return null;
  }
}

async function resolveGitDirectory(rootPath: string): Promise<string | null> {
  const dotGitPath = path.join(rootPath, ".git");

  try {
    const raw = await readFile(dotGitPath, "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(raw.trim());
    if (!match) {
      return null;
    }

    return path.resolve(rootPath, match[1]);
  } catch {
    return dotGitPath;
  }
}

async function readLooseRef(gitDir: string, refName: string): Promise<string | null> {
  try {
    return (await readFile(path.join(gitDir, refName), "utf8")).trim();
  } catch {
    return null;
  }
}

async function readPackedRef(gitDir: string, refName: string): Promise<string | null> {
  try {
    const packedRefs = await readFile(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packedRefs.split(/\r?\n/)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) {
        continue;
      }

      const [commit, name] = line.split(" ");
      if (name === refName) {
        return commit?.trim() ?? null;
      }
    }

    return null;
  } catch {
    return null;
  }
}
