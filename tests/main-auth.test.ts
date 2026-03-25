import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli/index";
import type { AuthService, AuthState, AuthStatus } from "../src/core/auth/types";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("main auth gate", () => {
  test("help bypasses authentication", async () => {
    const authService = new FakeAuthService();

    await captureConsole(async () => {
      await main(["help"], process.cwd(), {
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.ensureCalls).toBe(0);
  });

  test("normal commands require authentication first", async () => {
    const cwd = await createTempProject(`# Aura Agents

## Support Bot
Handles support.
`);
    const authService = new FakeAuthService();

    await captureConsole(async () => {
      await main(["list"], cwd, {
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.ensureCalls).toBe(1);
  });

  test("login bypasses the auth gate and uses the explicit login flow", async () => {
    const authService = new FakeAuthService();

    await captureConsole(async () => {
      await main(["login"], process.cwd(), {
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.ensureCalls).toBe(0);
    expect(authService.loginCalls).toBe(1);
  });

  test("whoami bypasses ensureAuthenticated and reads auth status", async () => {
    const authService = new FakeAuthService();

    await captureConsole(async () => {
      await main(["whoami"], process.cwd(), {
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.ensureCalls).toBe(0);
    expect(authService.statusCalls).toBe(1);
  });

  test("loads .env before creating the auth service", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-main-auth-"));
    tempDirectories.push(cwd);
    await writeFile(path.join(cwd, ".env"), "AURA_GOOGLE_CLIENT_ID=client-from-dotenv\n", "utf8");

    const originalValue = process.env.AURA_GOOGLE_CLIENT_ID;
    delete process.env.AURA_GOOGLE_CLIENT_ID;

    let observedClientId: string | undefined;

    try {
      await captureConsole(async () => {
        await main(["help"], cwd, {
          checkForUpdates: async () => null,
          createAuthService: () => {
            observedClientId = process.env.AURA_GOOGLE_CLIENT_ID;
            return new FakeAuthService();
          },
        });
      });
    } finally {
      if (originalValue === undefined) {
        delete process.env.AURA_GOOGLE_CLIENT_ID;
      } else {
        process.env.AURA_GOOGLE_CLIENT_ID = originalValue;
      }
    }

    expect(observedClientId).toBe("client-from-dotenv");
  });
});

class FakeAuthService implements AuthService {
  ensureCalls = 0;
  loginCalls = 0;
  logoutCalls = 0;
  statusCalls = 0;

  async ensureAuthenticated(): Promise<AuthState> {
    this.ensureCalls += 1;
    return createAuthState();
  }

  async login(): Promise<AuthState> {
    this.loginCalls += 1;
    return createAuthState();
  }

  async logout(): Promise<boolean> {
    this.logoutCalls += 1;
    return true;
  }

  async getStatus(): Promise<AuthStatus> {
    this.statusCalls += 1;
    return {
      authenticated: true,
      authState: createAuthState(),
      needsRefresh: false,
      path: "/tmp/aura/aura.json",
    };
  }
}

async function createTempProject(auraMarkdown: string): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "aura-main-auth-"));
  tempDirectories.push(cwd);
  await writeFile(path.join(cwd, "aura.md"), auraMarkdown, "utf8");
  return cwd;
}

async function captureConsole(run: () => Promise<void>): Promise<void> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
}

function createAuthState(): AuthState {
  return {
    sessionToken: "session-token",
    convexJwt: "convex-jwt",
    convexJwtExpiresAt: "2099-01-01T00:00:00.000Z",
    user: {
      id: "user_123",
      email: "teammate@example.com",
      name: "Teammate",
    },
    lastLoginAt: "2026-03-23T12:00:00.000Z",
    lastRefreshAt: "2026-03-23T12:00:00.000Z",
  };
}
