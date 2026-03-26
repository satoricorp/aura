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
  test("help authenticates first and does not list a login command", async () => {
    const authService = new FakeAuthService();

    const output = await captureConsole(async () => {
      await main(["help"], process.cwd(), {
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.statusCalls).toBe(1);
    expect(authService.ensureCalls).toBe(1);
    expect(output).toContain("Usage: aura <command>");
    expect(output).not.toContain("login   Sign in with Google and save a local Aura session");
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

  test("signed-out commands complete login and ask the user to rerun the command", async () => {
    const cwd = await createTempProject(`# Aura Agents

## Support Bot
Handles support.
`);
    const authService = new FakeAuthService({
      authenticated: false,
    });

    const output = await captureConsole(async () => {
      await main(["list"], cwd, {
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.statusCalls).toBe(1);
    expect(authService.ensureCalls).toBe(1);
    expect(output).toContain("Run `aura list` again.");
    expect(output).not.toContain("support-bot");
  });

  test("signed-out bare aura completes login and asks the user to rerun aura for help", async () => {
    const authService = new FakeAuthService({
      authenticated: false,
    });

    const output = await captureConsole(async () => {
      await main([], process.cwd(), {
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.statusCalls).toBe(1);
    expect(authService.ensureCalls).toBe(1);
    expect(output).toContain("Run `aura` again for the help menu.");
    expect(output).not.toContain("Usage: aura <command>");
  });

  test("logout bypasses the login flow and clears the saved session immediately", async () => {
    const authService = new FakeAuthService({
      authenticated: false,
    });

    await captureConsole(async () => {
      await main(["logout"], process.cwd(), {
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.statusCalls).toBe(0);
    expect(authService.ensureCalls).toBe(0);
    expect(authService.logoutCalls).toBe(1);
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
  logoutCalls = 0;
  statusCalls = 0;
  private readonly authenticated: boolean;

  constructor(options: { authenticated?: boolean } = {}) {
    this.authenticated = options.authenticated ?? true;
  }

  async ensureAuthenticated(): Promise<AuthState> {
    this.ensureCalls += 1;
    return createAuthState();
  }

  async logout(): Promise<boolean> {
    this.logoutCalls += 1;
    return true;
  }

  async getStatus(): Promise<AuthStatus> {
    this.statusCalls += 1;
    return {
      authenticated: this.authenticated,
      authState: this.authenticated ? createAuthState() : undefined,
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

async function captureConsole(run: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const calls: string[] = [];
  console.log = (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }

  return calls.join("\n");
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
