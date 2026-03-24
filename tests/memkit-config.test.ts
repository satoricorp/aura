import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createMemkitConfigStore } from "../src/core/auth/memkit-config";
import type { AuthState } from "../src/core/auth/types";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("memkit config store", () => {
  test("creates only the auth subtree when the file is missing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aura-memkit-"));
    tempDirectories.push(directory);
    const configPath = path.join(directory, "memkit.json");
    const store = createMemkitConfigStore(configPath);

    const loaded = await store.load();
    expect(loaded.exists).toBe(false);

    await store.saveAuthState(createAuthState());

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      auth: createAuthState(),
    });
  });

  test("preserves unrelated memkit keys when saving auth state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aura-memkit-"));
    tempDirectories.push(directory);
    const configPath = path.join(directory, "memkit.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          theme: "dark",
          nested: {
            keep: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const store = createMemkitConfigStore(configPath);
    const loaded = await store.load();
    await store.saveAuthState(createAuthState(), loaded.config);

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      theme: "dark",
      nested: {
        keep: true,
      },
      auth: createAuthState(),
    });
  });

  test("treats malformed JSON as a safe re-login case", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aura-memkit-"));
    tempDirectories.push(directory);
    const configPath = path.join(directory, "memkit.json");
    await writeFile(configPath, "{invalid json", "utf8");

    const store = createMemkitConfigStore(configPath);
    const loaded = await store.load();

    expect(loaded.auth).toBeUndefined();
    expect(loaded.malformed).toBe(true);
  });

  test("ignores an invalid auth block while preserving the rest of the file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aura-memkit-"));
    tempDirectories.push(directory);
    const configPath = path.join(directory, "memkit.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          theme: "light",
          auth: {
            sessionToken: 123,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const store = createMemkitConfigStore(configPath);
    const loaded = await store.load();

    expect(loaded.auth).toBeUndefined();
    expect(loaded.malformed).toBe(false);
    expect(loaded.config.theme).toBe("light");
  });
});

function createAuthState(): AuthState {
  return {
    sessionToken: "session-token",
    convexJwt: "convex-jwt",
    convexJwtExpiresAt: "2099-01-01T00:00:00.000Z",
    user: {
      id: "user_123",
      email: "teammate@example.com",
      name: "Teammate",
      picture: "https://example.com/picture.png",
    },
    lastLoginAt: "2026-03-23T12:00:00.000Z",
    lastRefreshAt: "2026-03-23T12:00:00.000Z",
  };
}
