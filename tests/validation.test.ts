import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createInPlaceValidationRunner } from "../src/core/generate";
import { pathExists } from "../src/core/utils/fs";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createInPlaceValidationRunner", () => {
  test("runs install and build in the surface directory and cleans up artifacts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-validation-"));
    tempDirectories.push(cwd);

    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "root", packageManager: "bun@1.2.18" }, null, 2),
      "utf8",
    );

    const surfaceDir = path.join(cwd, "src/agents/support-bot/api");
    await mkdir(surfaceDir, { recursive: true });
    await writeFile(
      path.join(surfaceDir, "package.json"),
      JSON.stringify(
        {
          name: "support-bot-api",
          version: "1.0.0",
          scripts: {
            build: "bun --version",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await createInPlaceValidationRunner(cwd).validate("support-bot", "api", surfaceDir);

    expect(await pathExists(path.join(surfaceDir, "node_modules"))).toBe(false);
    expect(await pathExists(path.join(surfaceDir, "bun.lock"))).toBe(false);
  });

  test("surfaces build failures with cleanup", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-validation-fail-"));
    tempDirectories.push(cwd);

    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "root", packageManager: "bun@1.2.18" }, null, 2),
      "utf8",
    );

    const surfaceDir = path.join(cwd, "src/agents/support-bot/api");
    await mkdir(surfaceDir, { recursive: true });
    await writeFile(
      path.join(surfaceDir, "package.json"),
      JSON.stringify(
        {
          name: "support-bot-api",
          version: "1.0.0",
          scripts: {
            build: 'bun -e "process.exit(1)"',
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(
      createInPlaceValidationRunner(cwd).validate("support-bot", "api", surfaceDir),
    ).rejects.toThrow("Validation failed for support-bot/api.");

    expect(await pathExists(path.join(surfaceDir, "node_modules"))).toBe(false);
    expect(await pathExists(path.join(surfaceDir, "bun.lock"))).toBe(false);
  });
});
