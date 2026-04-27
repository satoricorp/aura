import { describe, expect, test } from "bun:test";
import { copyToClipboard, type ClipboardRunner } from "../src/core/proxy/clipboard";

describe("copyToClipboard", () => {
  test("uses pbcopy on macOS", async () => {
    const calls: Array<{ args: string[]; command: string; input: string }> = [];
    const result = await copyToClipboard("hello", {
      platform: "darwin",
      runner: async (command, args, input) => {
        calls.push({ args, command, input });
      },
    });

    expect(result).toEqual({ copied: true });
    expect(calls).toEqual([{ args: [], command: "pbcopy", input: "hello" }]);
  });

  test("falls back between Linux clipboard commands", async () => {
    const commands: string[] = [];
    const runner: ClipboardRunner = async (command) => {
      commands.push(command);
      if (command !== "xclip") {
        throw new Error(`${command} missing`);
      }
    };

    const result = await copyToClipboard("hello", {
      platform: "linux",
      runner,
    });

    expect(result).toEqual({ copied: true });
    expect(commands).toEqual(["wl-copy", "xclip"]);
  });

  test("returns a failure without throwing", async () => {
    const result = await copyToClipboard("hello", {
      platform: "darwin",
      runner: async () => {
        throw new Error("missing clipboard");
      },
    });

    expect(result).toEqual({
      copied: false,
      error: "missing clipboard",
    });
  });
});
