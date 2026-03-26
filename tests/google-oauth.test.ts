import { describe, expect, test } from "bun:test";
import {
  buildGoogleAuthorizationUrl,
  exchangeAuthorizationCode,
  formatGoogleSignInAnnouncements,
  supportsTerminalHyperlinks,
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

describe("formatGoogleSignInAnnouncements", () => {
  const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client";

  test("uses a terminal hyperlink when the browser was opened and links are supported", () => {
    const messages = formatGoogleSignInAnnouncements({
      authorizationUrl: url,
      browserOpened: true,
      terminalSupportsHyperlinks: true,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe("A browser window was opened for Google sign-in.");
    expect(messages[1]).toBe(
      `If it did not open, \u001B]8;;${url}\u0007\u001B[4muse this URL\u001B[24m\u001B]8;;\u0007.`,
    );
    expect(messages).not.toContain(url);
    expect(messages[1]).not.toContain(`\n${url}`);
  });

  test("preserves the raw URL fallback when the browser was opened and links are unsupported", () => {
    const messages = formatGoogleSignInAnnouncements({
      authorizationUrl: url,
      browserOpened: true,
      terminalSupportsHyperlinks: false,
    });

    expect(messages).toEqual([
      "A browser window was opened for Google sign-in.",
      `If it did not open, use this URL instead:\n${url}`,
    ]);
  });

  test("uses a terminal hyperlink when the browser was not opened and links are supported", () => {
    const messages = formatGoogleSignInAnnouncements({
      authorizationUrl: url,
      browserOpened: false,
      terminalSupportsHyperlinks: true,
    });

    expect(messages).toEqual([
      `Open \u001B]8;;${url}\u0007\u001B[4mthis URL\u001B[24m\u001B]8;;\u0007 in your browser to continue signing in.`,
    ]);
    expect(messages).not.toContain(url);
  });

  test("preserves the raw URL fallback when the browser was not opened and links are unsupported", () => {
    const messages = formatGoogleSignInAnnouncements({
      authorizationUrl: url,
      browserOpened: false,
      terminalSupportsHyperlinks: false,
    });

    expect(messages).toEqual(["Open this URL in your browser to continue signing in:", url]);
  });
});

describe("supportsTerminalHyperlinks", () => {
  test("returns true for supported TERM_PROGRAM markers on a TTY", () => {
    expect(
      supportsTerminalHyperlinks(
        { isTTY: true },
        {
          TERM_PROGRAM: "WezTerm",
        },
      ),
    ).toBe(true);
  });

  test("returns true for Ghostty markers on a TTY", () => {
    expect(
      supportsTerminalHyperlinks(
        { isTTY: true },
        {
          TERM_PROGRAM: "ghostty",
        },
      ),
    ).toBe(true);

    expect(
      supportsTerminalHyperlinks(
        { isTTY: true },
        {
          TERM: "xterm-ghostty",
        },
      ),
    ).toBe(true);
  });

  test("returns true for supported VTE_VERSION values on a TTY", () => {
    expect(
      supportsTerminalHyperlinks(
        { isTTY: true },
        {
          VTE_VERSION: "6003",
        },
      ),
    ).toBe(true);
  });

  test("returns false when stdout is not a TTY even if markers are present", () => {
    expect(
      supportsTerminalHyperlinks(
        { isTTY: false },
        {
          TERM_PROGRAM: "iTerm.app",
          WT_SESSION: "1",
        },
      ),
    ).toBe(false);
  });

  test("returns false when no supported markers are present", () => {
    expect(
      supportsTerminalHyperlinks(
        { isTTY: true },
        {
          TERM_PROGRAM: "Terminal.app",
        },
      ),
    ).toBe(false);
  });
});
