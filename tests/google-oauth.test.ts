import { describe, expect, test } from "bun:test";
import {
  buildGoogleAuthorizationUrl,
  exchangeAuthorizationCode,
} from "../src/core/auth/google-oauth";

describe("buildGoogleAuthorizationUrl", () => {
  test("includes PKCE, state, and OpenID scopes", () => {
    const url = buildGoogleAuthorizationUrl({
      clientId: "client-id",
      redirectUri: "http://127.0.0.1:3210/oauth/callback",
      codeChallenge: "challenge-value",
      state: "state-value",
    });

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3210/oauth/callback");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
  });
});

describe("exchangeAuthorizationCode", () => {
  test("includes client_secret when provided", async () => {
    let observedBody = "";
    const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      observedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "access-token",
          id_token: "id-token",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    await exchangeAuthorizationCode(
      {
        clientId: "client-id",
        clientSecret: "secret-value",
        code: "auth-code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:3210/oauth/callback",
      },
      fetchImpl,
    );

    expect(observedBody).toContain("client_secret=secret-value");
    expect(observedBody).toContain("client_id=client-id");
    expect(observedBody).toContain("code_verifier=verifier");
  });

  test("omits client_secret when not provided", async () => {
    let observedBody = "";
    const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      observedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "access-token",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    await exchangeAuthorizationCode(
      {
        clientId: "client-id",
        code: "auth-code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:3210/oauth/callback",
      },
      fetchImpl,
    );

    expect(observedBody).not.toContain("client_secret=");
  });
});
