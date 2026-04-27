import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readAuraVersion } from "../src/core/package";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readAuraVersion", () => {
  test("prefers the abbreviated HEAD commit hash when git metadata exists", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-package-"));
    tempDirectories.push(cwd);

    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "aura", version: "0.0.0" }),
    );
    await writeFile(path.join(cwd, "README.md"), "hello\n");

    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["add", "package.json", "README.md"], { cwd });
    await execFileAsync(
      "git",
      ["-c", "user.name=Aura Test", "-c", "user.email=aura@example.com", "commit", "-m", "Initial"],
      { cwd },
    );

    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd });

    expect(await readAuraVersion(cwd)).toBe(stdout.trim());
  });

  test("falls back to the package version outside a git checkout", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-package-"));
    tempDirectories.push(cwd);

    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "aura", version: "1.2.3" }),
    );

    expect(await readAuraVersion(cwd)).toBe("1.2.3");
  });
});

describe("package distribution", () => {
  test("publishes the built Node CLI entry", async () => {
    const raw = await readFile(path.join(process.cwd(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      bin?: Record<string, string>;
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(pkg.bin?.aura).toBe("./dist/cli/index.js");
    expect(pkg.engines?.node).toBe(">=20");
    expect(pkg.scripts?.build).toContain("dist/cli/index.js");
    expect(pkg.scripts?.prepack).toBe("bun run build");
  });
});
