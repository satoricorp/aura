import { describe, expect, test } from "bun:test";
import { createAuthService } from "../src/core/auth/service";
import type {
  AuraConfigRecord,
  AuraConfigStore,
  AuthState,
  ConvexAuthClient,
  GoogleIdentityProof,
  GoogleOAuthClient,
  LoadedAuraConfig,
} from "../src/core/auth/types";

describe("auth service", () => {
  test("logs in through Google when there is no saved session", async () => {
    const store = new FakeAuraStore(createLoadedConfig(undefined));
    const google = new FakeGoogleOAuthClient();
    const convex = new FakeConvexAuthClient({
      exchangeResult: createAuthState("fresh-session", "2099-01-01T00:00:00.000Z"),
    });
    const authService = createAuthService({
      store,
      googleOAuthClient: google,
      convexAuthClient: convex,
      now: () => new Date("2026-03-23T12:00:00.000Z"),
    });

    const result = await authService.ensureAuthenticated();

    expect(result.sessionToken).toBe("fresh-session");
    expect(google.authenticateCalls).toBe(1);
    expect(convex.exchangeCalls).toBe(1);
    expect(convex.refreshCalls).toBe(0);
    expect(store.savedAuthState?.lastLoginAt).toBe("2026-03-23T12:00:00.000Z");
  });

  test("reuses a fresh cached JWT without refreshing", async () => {
    const existing = createAuthState("cached-session", "2099-01-01T00:00:00.000Z");
    const store = new FakeAuraStore(createLoadedConfig(existing));
    const google = new FakeGoogleOAuthClient();
    const convex = new FakeConvexAuthClient({
      exchangeResult: createAuthState("unused", "2099-01-01T00:00:00.000Z"),
      refreshResult: createAuthState("unused", "2099-01-01T00:00:00.000Z"),
    });
    const authService = createAuthService({
      store,
      googleOAuthClient: google,
      convexAuthClient: convex,
      now: () => new Date("2026-03-23T12:00:00.000Z"),
    });

    const result = await authService.ensureAuthenticated();

    expect(result).toEqual(existing);
    expect(google.authenticateCalls).toBe(0);
    expect(convex.refreshCalls).toBe(0);
    expect(store.savedAuthState).toBeUndefined();
  });

  test("refreshes silently when the cached JWT is expired", async () => {
    const existing = createAuthState("cached-session", "2026-03-23T11:00:00.000Z");
    const refreshed = createAuthState("cached-session", "2026-03-23T13:00:00.000Z");
    const store = new FakeAuraStore(createLoadedConfig(existing));
    const authService = createAuthService({
      store,
      googleOAuthClient: new FakeGoogleOAuthClient(),
      convexAuthClient: new FakeConvexAuthClient({
        exchangeResult: createAuthState("unused", "2099-01-01T00:00:00.000Z"),
        refreshResult: refreshed,
      }),
      now: () => new Date("2026-03-23T12:00:00.000Z"),
    });

    const result = await authService.ensureAuthenticated();

    expect(result.convexJwtExpiresAt).toBe("2026-03-23T13:00:00.000Z");
    expect(store.savedAuthState?.lastRefreshAt).toBe("2026-03-23T12:00:00.000Z");
  });

  test("falls back to a new browser login when refresh fails", async () => {
    const existing = createAuthState("cached-session", "2026-03-23T11:00:00.000Z");
    const store = new FakeAuraStore(createLoadedConfig(existing));
    const google = new FakeGoogleOAuthClient();
    const convex = new FakeConvexAuthClient({
      exchangeResult: createAuthState("replacement-session", "2026-03-23T13:00:00.000Z"),
      refreshError: new Error("revoked"),
    });
    const authService = createAuthService({
      store,
      googleOAuthClient: google,
      convexAuthClient: convex,
      now: () => new Date("2026-03-23T12:00:00.000Z"),
    });

    const result = await authService.ensureAuthenticated();

    expect(result.sessionToken).toBe("replacement-session");
    expect(google.authenticateCalls).toBe(1);
    expect(convex.refreshCalls).toBe(1);
    expect(convex.exchangeCalls).toBe(1);
  });

  test("skips refresh and starts a new login when the cached session token is missing", async () => {
    const existing = {
      ...createAuthState("cached-session", "2026-03-23T11:00:00.000Z"),
      sessionToken: undefined,
    } as unknown as AuthState;
    const store = new FakeAuraStore(createLoadedConfig(existing));
    const google = new FakeGoogleOAuthClient();
    const convex = new FakeConvexAuthClient({
      exchangeResult: createAuthState("replacement-session", "2026-03-23T13:00:00.000Z"),
      refreshResult: createAuthState("unused", "2026-03-23T13:00:00.000Z"),
    });
    const authService = createAuthService({
      store,
      googleOAuthClient: google,
      convexAuthClient: convex,
      now: () => new Date("2026-03-23T12:00:00.000Z"),
    });

    const result = await authService.ensureAuthenticated();

    expect(result.sessionToken).toBe("replacement-session");
    expect(google.authenticateCalls).toBe(1);
    expect(convex.refreshCalls).toBe(0);
    expect(convex.exchangeCalls).toBe(1);
  });

  test("revokes and clears the saved session on logout", async () => {
    const existing = createAuthState("cached-session", "2099-01-01T00:00:00.000Z");
    const store = new FakeAuraStore(createLoadedConfig(existing));
    const convex = new FakeConvexAuthClient({
      exchangeResult: createAuthState("unused", "2099-01-01T00:00:00.000Z"),
      refreshResult: createAuthState("unused", "2099-01-01T00:00:00.000Z"),
    });
    const authService = createAuthService({
      store,
      googleOAuthClient: new FakeGoogleOAuthClient(),
      convexAuthClient: convex,
    });

    const removed = await authService.logout();

    expect(removed).toBe(true);
    expect(convex.logoutCalls).toBe(1);
    expect(store.clearCalls).toBe(1);
  });

  test("clears the saved session on logout even when the session token is missing", async () => {
    const existing = {
      ...createAuthState("cached-session", "2099-01-01T00:00:00.000Z"),
      sessionToken: undefined,
    } as unknown as AuthState;
    const store = new FakeAuraStore(createLoadedConfig(existing));
    const convex = new FakeConvexAuthClient({
      exchangeResult: createAuthState("unused", "2099-01-01T00:00:00.000Z"),
      refreshResult: createAuthState("unused", "2099-01-01T00:00:00.000Z"),
    });
    const authService = createAuthService({
      store,
      googleOAuthClient: new FakeGoogleOAuthClient(),
      convexAuthClient: convex,
    });

    const removed = await authService.logout();

    expect(removed).toBe(true);
    expect(convex.logoutCalls).toBe(0);
    expect(store.clearCalls).toBe(1);
  });
});

class FakeAuraStore implements AuraConfigStore {
  savedAuthState: AuthState | undefined;
  clearCalls = 0;

  constructor(private loaded: LoadedAuraConfig) {}

  async load(): Promise<LoadedAuraConfig> {
    return this.loaded;
  }

  async saveAuthState(authState: AuthState, currentConfig?: AuraConfigRecord): Promise<void> {
    this.savedAuthState = authState;
    this.loaded = {
      ...this.loaded,
      auth: authState,
      config: {
        ...currentConfig,
        auth: authState,
      },
    };
  }

  async clearAuthState(currentConfig?: AuraConfigRecord): Promise<void> {
    this.clearCalls += 1;
    const nextConfig = { ...currentConfig };
    delete nextConfig.auth;
    this.loaded = {
      ...this.loaded,
      auth: undefined,
      config: nextConfig,
    };
  }
}

class FakeGoogleOAuthClient implements GoogleOAuthClient {
  authenticateCalls = 0;

  async authenticate(): Promise<GoogleIdentityProof> {
    this.authenticateCalls += 1;
    return {
      accessToken: "google-access-token",
      idToken: "google-id-token",
    };
  }
}

class FakeConvexAuthClient implements ConvexAuthClient {
  exchangeCalls = 0;
  refreshCalls = 0;
  logoutCalls = 0;
  private readonly exchangeResult: AuthState;
  private readonly refreshResult: AuthState;
  private readonly refreshError?: Error;

  constructor(options: {
    exchangeResult: AuthState;
    refreshResult?: AuthState;
    refreshError?: Error;
  }) {
    this.exchangeResult = options.exchangeResult;
    this.refreshResult = options.refreshResult ?? options.exchangeResult;
    this.refreshError = options.refreshError;
  }

  async exchangeGoogleLogin(): Promise<AuthState> {
    this.exchangeCalls += 1;
    return this.exchangeResult;
  }

  async refreshSession(): Promise<AuthState> {
    this.refreshCalls += 1;
    if (this.refreshError) {
      throw this.refreshError;
    }

    return this.refreshResult;
  }

  async logoutSession(): Promise<void> {
    this.logoutCalls += 1;
  }
}

function createLoadedConfig(auth: AuthState | undefined): LoadedAuraConfig {
  return {
    auth,
    config: auth ? { auth } : {},
    exists: Boolean(auth),
    malformed: false,
    path: "/tmp/aura/aura.json",
  };
}

function createAuthState(sessionToken: string, expiresAt: string): AuthState {
  return {
    sessionToken,
    convexJwt: `${sessionToken}-jwt`,
    convexJwtExpiresAt: expiresAt,
    user: {
      id: "user_123",
      email: "teammate@example.com",
      name: "Teammate",
    },
    lastLoginAt: "2026-03-23T10:00:00.000Z",
    lastRefreshAt: "2026-03-23T10:00:00.000Z",
  };
}
