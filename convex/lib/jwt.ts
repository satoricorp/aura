"use node";

import { createHash, createPrivateKey, createSign, randomBytes } from "node:crypto";
import { resolveAuthAudience } from "./authEnv";

const DEFAULT_TTL_SECONDS = 15 * 60;

export interface JwtIdentity {
  userId: string;
  email: string;
  name?: string;
  picture?: string;
  sessionId?: string;
}

export interface SignConvexJwtOptions {
  issuer?: string;
  audience?: string;
  keyId?: string;
  privateKeyPem?: string;
  now?: Date;
  ttlSeconds?: number;
}

export interface SignedConvexJwt {
  token: string;
  expiresAt: string;
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signConvexJwt(
  identity: JwtIdentity,
  options: SignConvexJwtOptions = {},
): SignedConvexJwt {
  const now = options.now ?? new Date();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const privateKeyPem = normalizePem(
    options.privateKeyPem ?? requireEnv("AURA_AUTH_PRIVATE_KEY_PEM"),
  );

  const header = {
    alg: "RS256",
    kid: options.keyId ?? process.env.AURA_AUTH_KEY_ID ?? "aura-local",
    typ: "JWT",
  };
  const payload = {
    aud: options.audience ?? resolveAuthAudience(),
    email: identity.email,
    exp: expiresAt,
    iat: issuedAt,
    iss: options.issuer ?? requireEnv("AURA_AUTH_ISSUER"),
    name: identity.name,
    picture: identity.picture,
    properties: {
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
      sessionId: identity.sessionId,
      userId: identity.userId,
    },
    sub: identity.userId,
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  const privateKey = createPrivateKey(privateKeyPem);
  const signature = signer.sign(privateKey).toString("base64url");

  return {
    token: `${signingInput}.${signature}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to sign Convex auth JWTs.`);
  }

  return value;
}
