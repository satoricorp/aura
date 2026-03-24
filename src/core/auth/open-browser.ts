import { spawn } from "node:child_process";

export async function openSystemBrowser(url: string): Promise<boolean> {
  const candidates =
    process.platform === "darwin"
      ? [["open", url]]
      : process.platform === "win32"
        ? [["cmd", "/c", "start", "", url]]
        : [["xdg-open", url]];

  for (const [command, ...args] of candidates) {
    const opened = await attemptOpen(command, args);
    if (opened) {
      return true;
    }
  }

  return false;
}

function attemptOpen(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: process.platform !== "win32",
    });

    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
