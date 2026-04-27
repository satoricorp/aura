import { homedir } from "node:os";
import path from "node:path";

export interface ProxyConfig {
  clipboardDisabled: boolean;
  logDir: string;
  port: number;
  upstreamOrigin: string;
  verdictDisabled: boolean;
  verdictModel: string;
}

const DEFAULT_PORT = 8787;
const DEFAULT_VERDICT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_UPSTREAM_ORIGIN = "https://api.anthropic.com";

export function loadProxyConfig(env = process.env): ProxyConfig {
  return {
    clipboardDisabled: env.AURA_DISABLE_CLIPBOARD === "1",
    logDir: env.AURA_LOG_DIR ?? path.join(homedir(), ".aura", "sessions"),
    port: parsePort(env.AURA_PORT, DEFAULT_PORT),
    upstreamOrigin: env.AURA_UPSTREAM_ORIGIN ?? DEFAULT_UPSTREAM_ORIGIN,
    verdictDisabled: env.AURA_DISABLE_VERDICT === "1",
    verdictModel: env.AURA_VERDICT_MODEL ?? DEFAULT_VERDICT_MODEL,
  };
}

export function parsePort(value: string | undefined, fallback = DEFAULT_PORT): number {
  if (!value) {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port "${value}". Expected a number from 1 to 65535.`);
  }

  return port;
}
