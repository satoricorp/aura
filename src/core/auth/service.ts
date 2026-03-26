import { HttpConvexAuthClient } from "./convex-auth-client";
import { GoogleDesktopOAuthClient } from "./google-oauth";
import { createAuraConfigStore } from "./aura-config";
import type {
  AuraConfigStore,
  AuthService,
  AuthState,
  AuthStatus,
  ConvexAuthClient,
  GoogleOAuthClient,
} from "./types";

export interface CreateAuthServiceOptions {
  store?: AuraConfigStore;
  googleOAuthClient?: GoogleOAuthClient;
  convexAuthClient?: ConvexAuthClient;
  now?: () => Date;
}

export function createAuthService(options: CreateAuthServiceOptions = {}): AuthService {
  const store = options.store ?? createAuraConfigStore();
  const googleOAuthClient = options.googleOAuthClient ?? new GoogleDesktopOAuthClient();
  const convexAuthClient = options.convexAuthClient ?? new HttpConvexAuthClient();
  const now = options.now ?? (() => new Date());

  return {
    async ensureAuthenticated(): Promise<AuthState> {
      const loaded = await store.load();
      const currentAuth = loaded.auth;

      if (!currentAuth) {
        return loginWithFreshBrowserSession(
          store,
          googleOAuthClient,
          convexAuthClient,
          loaded.config,
          now,
        );
      }

      if (!isExpired(currentAuth.convexJwtExpiresAt, now())) {
        return currentAuth;
      }

      const sessionToken = getUsableSessionToken(currentAuth.sessionToken);
      if (!sessionToken) {
        return loginWithFreshBrowserSession(
          store,
          googleOAuthClient,
          convexAuthClient,
          loaded.config,
          now,
        );
      }

      try {
        const refreshed = await convexAuthClient.refreshSession(sessionToken);
        const nextState = {
          ...refreshed,
          lastLoginAt: currentAuth.lastLoginAt ?? refreshed.lastLoginAt,
          lastRefreshAt: now().toISOString(),
        };
        await store.saveAuthState(nextState, loaded.config);
        return nextState;
      } catch {
        return loginWithFreshBrowserSession(
          store,
          googleOAuthClient,
          convexAuthClient,
          loaded.config,
          now,
        );
      }
    },

    async logout(): Promise<boolean> {
      const loaded = await store.load();
      if (!loaded.auth) {
        return false;
      }

      try {
        const sessionToken = getUsableSessionToken(loaded.auth.sessionToken);
        if (sessionToken) {
          await convexAuthClient.logoutSession(sessionToken);
        }
      } finally {
        await store.clearAuthState(loaded.config);
      }

      return true;
    },

    async getStatus(): Promise<AuthStatus> {
      const loaded = await store.load();
      return {
        authenticated: Boolean(loaded.auth),
        authState: loaded.auth,
        needsRefresh: loaded.auth ? isExpired(loaded.auth.convexJwtExpiresAt, now()) : false,
        path: loaded.path,
      };
    },
  };
}

async function loginWithFreshBrowserSession(
  store: AuraConfigStore,
  googleOAuthClient: GoogleOAuthClient,
  convexAuthClient: ConvexAuthClient,
  currentConfig: Record<string, unknown>,
  now: () => Date,
): Promise<AuthState> {
  const proof = await googleOAuthClient.authenticate();
  const state = await convexAuthClient.exchangeGoogleLogin(proof);
  const timestamp = now().toISOString();
  const nextState: AuthState = {
    ...state,
    lastLoginAt: timestamp,
    lastRefreshAt: timestamp,
  };
  await store.saveAuthState(nextState, currentConfig);
  return nextState;
}

function isExpired(value: string, reference: Date): boolean {
  const expiresAt = Date.parse(value);
  if (Number.isNaN(expiresAt)) {
    return true;
  }

  return expiresAt <= reference.getTime();
}

function getUsableSessionToken(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
