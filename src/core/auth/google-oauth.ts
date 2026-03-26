import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { URL, URLSearchParams } from "node:url";
import type { GoogleIdentityProof, GoogleOAuthClient } from "./types";
import { openSystemBrowser } from "./open-browser";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALLBACK_HOST = "127.0.0.1";
const GOOGLE_SCOPES = ["openid", "email", "profile"];
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OSC_8 = "\u001B]8;;";
const OSC_8_END = "\u0007";
const UNDERLINE_ON = "\u001B[4m";
const UNDERLINE_OFF = "\u001B[24m";

export interface GoogleDesktopOAuthClientOptions {
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  announce?: (message: string) => void;
}

export class GoogleDesktopOAuthClient implements GoogleOAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly announce: (message: string) => void;

  constructor(options: GoogleDesktopOAuthClientOptions = {}) {
    this.clientId = options.clientId ?? process.env.AURA_GOOGLE_CLIENT_ID ?? "";
    this.clientSecret = options.clientSecret ?? process.env.AURA_GOOGLE_CLIENT_SECRET ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.announce = options.announce ?? console.log;
  }

  async authenticate(): Promise<GoogleIdentityProof> {
    if (!this.clientId) {
      throw new Error("AURA_GOOGLE_CLIENT_ID is required to sign in with Google.");
    }

    const verifier = randomBase64Url(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBase64Url(32);
    const callback = await createLoopbackServer(state);

    const authorizationUrl = buildGoogleAuthorizationUrl({
      clientId: this.clientId,
      redirectUri: callback.redirectUri,
      codeChallenge: challenge,
      state,
    });

    const opened = await openSystemBrowser(authorizationUrl.toString());
    for (const message of formatGoogleSignInAnnouncements({
      authorizationUrl: authorizationUrl.toString(),
      browserOpened: opened,
    })) {
      this.announce(message);
    }

    try {
      const code = await callback.waitForCode();
      return exchangeAuthorizationCode(
        {
          clientId: this.clientId,
          clientSecret: this.clientSecret || undefined,
          code,
          codeVerifier: verifier,
          redirectUri: callback.redirectUri,
        },
        this.fetchImpl,
      );
    } finally {
      await callback.close();
    }
  }
}

export function buildGoogleAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): URL {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    state: options.state,
    access_type: "online",
    include_granted_scopes: "true",
  }).toString();
  return url;
}

export function formatGoogleSignInAnnouncements(options: {
  authorizationUrl: string;
  browserOpened: boolean;
  terminalSupportsHyperlinks?: boolean;
}): string[] {
  const supportsHyperlinks =
    options.terminalSupportsHyperlinks ?? supportsTerminalHyperlinks(process.stdout, process.env);

  if (supportsHyperlinks) {
    if (options.browserOpened) {
      return [
        "A browser window was opened for Google sign-in.",
        `If it did not open, ${formatTerminalHyperlink("use this URL", options.authorizationUrl)}.`,
      ];
    }

    return [
      `Open ${formatTerminalHyperlink("this URL", options.authorizationUrl)} in your browser to continue signing in.`,
    ];
  }

  if (options.browserOpened) {
    return [
      "A browser window was opened for Google sign-in.",
      `If it did not open, use this URL instead:\n${options.authorizationUrl}`,
    ];
  }

  return ["Open this URL in your browser to continue signing in:", options.authorizationUrl];
}

export function supportsTerminalHyperlinks(
  output: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (output.isTTY !== true) {
    return false;
  }

  if (
    env.TERM_PROGRAM === "iTerm.app" ||
    env.TERM_PROGRAM === "ghostty" ||
    env.TERM_PROGRAM === "WezTerm" ||
    env.TERM_PROGRAM === "vscode"
  ) {
    return true;
  }

  if (env.WT_SESSION || env.KONSOLE_VERSION || env.DOMTERM) {
    return true;
  }

  if (env.TERM === "xterm-kitty" || env.TERM === "xterm-ghostty") {
    return true;
  }

  const vteVersion = Number.parseInt(env.VTE_VERSION ?? "", 10);
  return Number.isInteger(vteVersion) && vteVersion >= 5000;
}

export async function exchangeAuthorizationCode(
  options: {
    clientId: string;
    clientSecret?: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch,
): Promise<GoogleIdentityProof> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: options.redirectUri,
  });
  if (options.clientSecret) {
    body.set("client_secret", options.clientSecret);
  }

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Google token exchange failed with ${response.status}: ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    id_token?: string;
  };

  if (!payload.access_token) {
    throw new Error("Google token exchange did not return an access token.");
  }

  return {
    accessToken: payload.access_token,
    idToken: payload.id_token,
  };
}

async function createLoopbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }

    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");

    if (error) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Google sign-in failed. You can return to Aura.");
      rejectCode?.(new Error(`Google sign-in failed: ${error}`));
      return;
    }

    if (state !== expectedState || !code) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid OAuth callback. You can return to Aura.");
      rejectCode?.(new Error("Received an invalid OAuth callback from Google."));
      return;
    }

    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Sign-in complete. You can return to Aura.");
    resolveCode?.(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, GOOGLE_CALLBACK_HOST, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Aura could not start the local OAuth callback server.");
  }

  const timer = setTimeout(() => {
    rejectCode?.(new Error("Timed out waiting for the Google OAuth callback."));
  }, OAUTH_TIMEOUT_MS);

  return {
    redirectUri: `http://${GOOGLE_CALLBACK_HOST}:${address.port}/oauth/callback`,
    async waitForCode(): Promise<string> {
      try {
        return await codePromise;
      } finally {
        clearTimeout(timer);
      }
    },
    async close(): Promise<void> {
      clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function formatTerminalHyperlink(label: string, url: string): string {
  return `${OSC_8}${url}${OSC_8_END}${UNDERLINE_ON}${label}${UNDERLINE_OFF}${OSC_8}${OSC_8_END}`;
}
