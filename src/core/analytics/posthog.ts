export type PostHogPropertyValue = boolean | number | string | null | undefined;

export interface PostHogProperties {
  [key: string]: PostHogPropertyValue;
}

export interface PostHogCaptureRequest {
  distinctId: string;
  event: string;
  properties?: PostHogProperties;
}

export interface PostHogClient {
  readonly enabled: boolean;
  capture(request: PostHogCaptureRequest): Promise<void>;
}

export interface CreatePostHogClientOptions {
  disabled?: boolean;
  fetchImpl?: typeof fetch;
  host?: string;
  projectToken?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 1500;
const POSTHOG_CAPTURE_PATH = "/i/v0/e/";

export function createPostHogClient(options: CreatePostHogClientOptions = {}): PostHogClient {
  const projectToken = options.projectToken ?? process.env.AURA_POSTHOG_PROJECT_TOKEN ?? "";
  const host = normalizeHost(options.host ?? process.env.AURA_POSTHOG_HOST ?? "");
  const disabled = options.disabled ?? process.env.AURA_DISABLE_ANALYTICS === "1";
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const enabled = !disabled && Boolean(projectToken) && Boolean(host);

  return {
    enabled,
    async capture(request: PostHogCaptureRequest): Promise<void> {
      if (!enabled || !request.distinctId) {
        return;
      }

      try {
        await fetchImpl(`${host}${POSTHOG_CAPTURE_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            api_key: projectToken,
            distinct_id: request.distinctId,
            event: request.event,
            properties: compactProperties(request.properties),
          }),
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch {
        // Best-effort analytics must never affect auth or command execution.
      }
    },
  };
}

function compactProperties(properties: PostHogProperties | undefined): PostHogProperties | undefined {
  if (!properties) {
    return undefined;
  }

  const entries = Object.entries(properties).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeHost(value: string): string {
  return value.replace(/\/+$/, "");
}
