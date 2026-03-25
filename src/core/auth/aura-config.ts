import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuraConfigRecord, AuraConfigStore, AuthState, LoadedAuraConfig } from "./types";

export const AURA_AUTH_CONFIG_PATH = path.join(os.homedir(), ".config", "aura", "aura.json");

export function createAuraConfigStore(configPath = AURA_AUTH_CONFIG_PATH): AuraConfigStore {
  return {
    async load(): Promise<LoadedAuraConfig> {
      return loadConfigFile(configPath);
    },

    async saveAuthState(authState: AuthState, currentConfig?: AuraConfigRecord): Promise<void> {
      const loaded = currentConfig ?? (await this.load()).config;
      const next: AuraConfigRecord = {
        ...loaded,
        auth: sanitizeAuthState(authState),
      };

      await writeConfigFile(configPath, next);
    },

    async clearAuthState(currentConfig?: AuraConfigRecord): Promise<void> {
      const loaded = currentConfig ?? (await this.load()).config;
      const next: AuraConfigRecord = { ...loaded };
      delete next.auth;
      await writeConfigFile(configPath, next);
    },
  };
}

async function loadConfigFile(configPath: string): Promise<LoadedAuraConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isJsonObject(parsed)) {
      return {
        config: {},
        exists: true,
        malformed: true,
        path: configPath,
      };
    }

    return {
      auth: parseAuthState(parsed.auth),
      config: parsed as AuraConfigRecord,
      exists: true,
      malformed: false,
      path: configPath,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        config: {},
        exists: false,
        malformed: false,
        path: configPath,
      };
    }

    return {
      config: {},
      exists: true,
      malformed: true,
      path: configPath,
    };
  }
}

async function writeConfigFile(configPath: string, contents: AuraConfigRecord): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  await chmod(configPath, 0o600);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuthState(value: unknown): AuthState | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  if (
    typeof value.sessionToken !== "string" ||
    typeof value.convexJwt !== "string" ||
    typeof value.convexJwtExpiresAt !== "string" ||
    !isJsonObject(value.user) ||
    typeof value.user.id !== "string" ||
    typeof value.user.email !== "string"
  ) {
    return undefined;
  }

  return sanitizeAuthState({
    sessionToken: value.sessionToken,
    convexJwt: value.convexJwt,
    convexJwtExpiresAt: value.convexJwtExpiresAt,
    user: {
      id: value.user.id,
      email: value.user.email,
      name: typeof value.user.name === "string" ? value.user.name : undefined,
      picture: typeof value.user.picture === "string" ? value.user.picture : undefined,
    },
    lastLoginAt: typeof value.lastLoginAt === "string" ? value.lastLoginAt : undefined,
    lastRefreshAt: typeof value.lastRefreshAt === "string" ? value.lastRefreshAt : undefined,
  });
}

function sanitizeAuthState(value: AuthState): AuthState {
  return {
    sessionToken: value.sessionToken,
    convexJwt: value.convexJwt,
    convexJwtExpiresAt: value.convexJwtExpiresAt,
    user: {
      id: value.user.id,
      email: value.user.email,
      name: value.user.name,
      picture: value.user.picture,
    },
    lastLoginAt: value.lastLoginAt,
    lastRefreshAt: value.lastRefreshAt,
  };
}
