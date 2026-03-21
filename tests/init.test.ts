import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAuraProject } from "../src/cli/commands/init";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("scaffoldAuraProject", () => {
  test("creates aura.md and aura.config.ts once without overwriting them", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-init-"));
    tempDirectories.push(cwd);

    const firstRun = await scaffoldAuraProject(cwd);
    const secondRun = await scaffoldAuraProject(cwd);

    expect(firstRun.created.map((filePath) => path.basename(filePath)).sort()).toEqual([
      "aura.config.ts",
      "aura.md",
    ]);
    expect(secondRun.created).toHaveLength(0);
    expect(secondRun.skipped.map((filePath) => path.basename(filePath)).sort()).toEqual([
      "aura.config.ts",
      "aura.md",
    ]);

    const auraMarkdown = await readFile(path.join(cwd, "aura.md"), "utf8");
    const auraConfig = await readFile(path.join(cwd, "aura.config.ts"), "utf8");

    expect(auraMarkdown).toContain("## Example Agent");
    expect(auraConfig).toContain('import { config } from "aura";');
  });
});
