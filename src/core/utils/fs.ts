import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(targetPath: string): Promise<string> {
  return readFile(targetPath, "utf8");
}

export async function writeText(targetPath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents, "utf8");
}

export async function writeTextIfMissing(targetPath: string, contents: string): Promise<boolean> {
  if (await pathExists(targetPath)) {
    return false;
  }

  await writeText(targetPath, contents);
  return true;
}
