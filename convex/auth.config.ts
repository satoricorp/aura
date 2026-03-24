import type { AuthConfig } from "convex/server";
import { resolveAuthAudience } from "./lib/authEnv";

const issuer = requireEnv("AURA_AUTH_ISSUER");
const applicationID = resolveAuthAudience();
const jwks = requireEnv("AURA_AUTH_JWKS");

const authConfig = {
  providers: [
    {
      type: "customJwt",
      issuer,
      applicationID,
      jwks,
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;

export default authConfig;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for Convex auth configuration.`);
  }

  return value;
}
