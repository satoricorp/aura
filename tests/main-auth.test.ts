import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli/index";
import type { PostHogCaptureRequest, PostHogClient } from "../src/core/analytics/posthog";
import type { AuthService, AuthState, AuthStatus } from "../src/core/auth/types";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("main auth gate", () => {
  test("help and --version bypass auth and emit no analytics", async () => {
    const authService = new FakeAuthService();
    const analytics = new FakeAnalyticsClient();

    const helpOutput = await captureConsole(async () => {
      await main(["help"], process.cwd(), {
        analytics,
        authService,
        checkForUpdates: async () => null,
      });
    });

    const versionOutput = await captureConsole(async () => {
      await main(["--version"], process.cwd(), {
        analytics,
        authService,
        checkForUpdates: async () => null,
        readVersion: async () => "1.2.3",
      });
    });

    expect(authService.ensureCalls).toBe(0);
    expect(authService.loginCalls).toBe(0);
    expect(authService.statusCalls).toBe(0);
    expect(analytics.captures).toHaveLength(0);
    expect(helpOutput).toContain("Usage: aura <command>");
    expect(versionOutput).toContain("1.2.3");
  });

  test("normal commands require authentication first and emit command completed", async () => {
    const cwd = await createTempProject(`# Aura Agents

## Support Bot
Handles support.
`);
    const authService = new FakeAuthService();
    const analytics = new FakeAnalyticsClient();

    await captureConsole(async () => {
      await main(["list"], cwd, {
        analytics,
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.ensureCalls).toBe(1);
    expect(analytics.captures).toEqual([
      {
        distinctId: "user_123",
        event: "command completed",
        properties: expect.objectContaining({
          authenticated: true,
          command: "list",
          success: true,
        }),
      },
    ]);
  });

  test("login bypasses ensureAuthenticated and emits command completed", async () => {
    const authService = new FakeAuthService();
    const analytics = new FakeAnalyticsClient();

    await captureConsole(async () => {
      await main(["login"], process.cwd(), {
        analytics,
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.ensureCalls).toBe(0);
    expect(authService.loginCalls).toBe(1);
    expect(analytics.captures).toEqual([
      {
        distinctId: "user_123",
        event: "command completed",
        properties: expect.objectContaining({
          authenticated: true,
          command: "login",
          success: true,
        }),
      },
    ]);
  });

  test("logout bypasses ensureAuthenticated and emits logout plus command completion", async () => {
    const authService = new FakeAuthService();
    const analytics = new FakeAnalyticsClient();

    await captureConsole(async () => {
      await main(["logout"], process.cwd(), {
        analytics,
        authService,
        checkForUpdates: async () => null,
      });
    });

    expect(authService.ensureCalls).toBe(0);
    expect(authService.statusCalls).toBe(1);
    expect(authService.logoutCalls).toBe(1);
    expect(analytics.captures).toEqual([
      {
        distinctId: "user_123",
        event: "user logged out",
        properties: expect.objectContaining({
          authenticated: true,
          command: "logout",
        }),
      },
      {
        distinctId: "user_123",
        event: "command completed",
        properties: expect.objectContaining({
          authenticated: true,
          command: "logout",
          success: true,
        }),
      },
    ]);
  });

  test("command failures emit command failed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-main-auth-"));
    tempDirectories.push(cwd);
    const authService = new FakeAuthService();
    const analytics = new FakeAnalyticsClient();

    await expect(
      captureConsole(async () => {
        await main(["list"], cwd, {
          analytics,
          authService,
          checkForUpdates: async () => null,
        });
      }),
    ).rejects.toThrow("aura.md not found");

    expect(analytics.captures).toEqual([
      {
        distinctId: "user_123",
        event: "command failed",
        properties: expect.objectContaining({
          authenticated: true,
          command: "list",
          success: false,
        }),
      },
    ]);
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

class FakeAnalyticsClient implements PostHogClient {
  readonly enabled = true;
  readonly captures: PostHogCaptureRequest[] = [];

  async capture(request: PostHogCaptureRequest): Promise<void> {
    this.captures.push(request);
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
