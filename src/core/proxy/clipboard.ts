import { spawn } from "node:child_process";

export type ClipboardRunner = (command: string, args: string[], input: string) => Promise<void>;

export interface ClipboardResult {
  copied: boolean;
  error?: string;
}

export async function copyToClipboard(
  text: string,
  options: {
    platform?: NodeJS.Platform;
    runner?: ClipboardRunner;
  } = {},
): Promise<ClipboardResult> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runClipboardCommand;
  const commands = clipboardCommands(platform);
  let lastError = "No clipboard command available for this platform.";

  for (const [command, args] of commands) {
    try {
      await runner(command, args, text);
      return { copied: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    copied: false,
    error: lastError,
  };
}

function clipboardCommands(platform: NodeJS.Platform): Array<[string, string[]]> {
  if (platform === "darwin") {
    return [["pbcopy", []]];
  }

  if (platform === "win32") {
    return [["clip", []]];
  }

  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}

function runClipboardCommand(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
    child.stdin.end(input);
  });
}
