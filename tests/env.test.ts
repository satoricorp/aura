import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAuraEnv, parseDotEnv } from "../src/core/env";

const tempDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseDotEnv", () => {
  test("parses plain, quoted, and export-prefixed values", () => {
    const parsed = parseDotEnv(`
# comment
AURA_GOOGLE_CLIENT_ID=plain-client-id
export AURA_CONVEX_URL="https://example.convex.site"
OPENAI_API_KEY='test-key'
EMPTY=
INLINE=value # trailing comment
`);

    expect(parsed.get("AURA_GOOGLE_CLIENT_ID")).toBe("plain-client-id");
    expect(parsed.get("AURA_CONVEX_URL")).toBe("https://example.convex.site");
    expect(parsed.get("OPENAI_API_KEY")).toBe("test-key");
    expect(parsed.get("EMPTY")).toBe("");
    expect(parsed.get("INLINE")).toBe("value");
  });

  test("prefers .env.local over .env while still loading both files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-env-"));
    tempDirectories.push(cwd);
    const originalEnv = snapshotEnv([
      "AURA_CONVEX_URL",
      "AURA_GOOGLE_CLIENT_ID",
      "AURA_AUTH_ISSUER",
    ]);

    delete process.env.AURA_CONVEX_URL;
    delete process.env.AURA_GOOGLE_CLIENT_ID;
    delete process.env.AURA_AUTH_ISSUER;

    await writeFile(
      path.join(cwd, ".env"),
      "AURA_CONVEX_URL=https://old.convex.site\nAURA_GOOGLE_CLIENT_ID=base-client\n",
      "utf8",
    );
    await writeFile(
      path.join(cwd, ".env.local"),
      "AURA_CONVEX_URL=https://new.convex.site\nAURA_AUTH_ISSUER=https://issuer.example.com\n",
      "utf8",
    );

    try {
      await loadAuraEnv(cwd);

      expect(process.env.AURA_CONVEX_URL).toBe("https://new.convex.site");
      expect(process.env.AURA_GOOGLE_CLIENT_ID).toBe("base-client");
      expect(process.env.AURA_AUTH_ISSUER).toBe("https://issuer.example.com");
    } finally {
      restoreEnv(originalEnv);
    }
  });

  test("does not override environment variables already set by the shell", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-env-"));
    tempDirectories.push(cwd);
    const originalEnv = snapshotEnv(["AURA_CONVEX_URL", "AURA_GOOGLE_CLIENT_ID"]);

    process.env.AURA_CONVEX_URL = "https://shell.convex.site";
    delete process.env.AURA_GOOGLE_CLIENT_ID;

    await writeFile(
      path.join(cwd, ".env"),
      "AURA_CONVEX_URL=https://old.convex.site\nAURA_GOOGLE_CLIENT_ID=base-client\n",
      "utf8",
    );
    await writeFile(path.join(cwd, ".env.local"), "AURA_CONVEX_URL=https://new.convex.site\n");

    try {
      await loadAuraEnv(cwd);

      expect(process.env.AURA_CONVEX_URL).toBe("https://shell.convex.site");
      expect(process.env.AURA_GOOGLE_CLIENT_ID).toBe("base-client");
    } finally {
      restoreEnv(originalEnv);
    }
  });
});

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
