import { mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { writeText } from "../utils/fs";
import type { SessionLogEntry, SessionLogEntryType } from "./types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class SessionLog {
  readonly filePath: string;

  constructor(
    private readonly logDir: string,
    requestId: string,
    now = new Date(),
  ) {
    this.filePath = path.join(logDir, `${toFileTimestamp(now)}-${requestId}.jsonl`);
  }

  async append(type: SessionLogEntryType, data: unknown): Promise<void> {
    const entry: SessionLogEntry = {
      ts: new Date().toISOString(),
      type,
      data,
    };

    await appendLine(this.filePath, `${JSON.stringify(entry)}\n`);
  }
}

export async function rotateOldSessionLogs(logDir: string, now = new Date()): Promise<void> {
  await mkdir(logDir, { recursive: true });
  const archiveDir = path.join(logDir, "archive");
  const entries = await readdir(logDir, { withFileTypes: true });

  await mkdir(archiveDir, { recursive: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(async (entry) => {
        const source = path.join(logDir, entry.name);
        const metadata = await stat(source);
        if (now.getTime() - metadata.mtimeMs < SEVEN_DAYS_MS) {
          return;
        }

        await rename(source, path.join(archiveDir, entry.name));
      }),
  );
}

function toFileTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function appendLine(targetPath: string, line: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(targetPath, line, "utf8");
}

export async function writeSessionLog(targetPath: string, entry: SessionLogEntry): Promise<void> {
  await writeText(targetPath, `${JSON.stringify(entry)}\n`);
}
