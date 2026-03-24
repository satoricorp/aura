import type { AuthState, ConvexAuthClient, GoogleIdentityProof } from "./types";

export interface HttpConvexAuthClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class HttpConvexAuthClient implements ConvexAuthClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpConvexAuthClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.AURA_CONVEX_URL ?? "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async exchangeGoogleLogin(proof: GoogleIdentityProof): Promise<AuthState> {
    return this.postJson("/auth/exchange-google-login", proof);
  }

  async refreshSession(sessionToken: string): Promise<AuthState> {
    return this.postJson("/auth/refresh-session", { sessionToken });
  }

  async logoutSession(sessionToken: string): Promise<void> {
    await this.postJson("/auth/logout-session", { sessionToken });
  }

  private async postJson<T>(pathname: string, body: unknown): Promise<T> {
    if (!this.baseUrl) {
      throw new Error("AURA_CONVEX_URL is required to reach the Convex auth backend.");
    }

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Auth request failed with ${response.status}: ${await response.text()}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
