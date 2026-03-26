import { describe, expect, test } from "bun:test";
import { createPostHogClient } from "../src/core/analytics/posthog";

describe("createPostHogClient", () => {
  test("posts the expected capture payload", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const client = createPostHogClient({
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calls.push({ input: String(input), init });
        return new Response(null, { status: 200 });
      }) as typeof fetch,
      host: "https://app.posthog.test/",
      projectToken: "project-token",
    });

    await client.capture({
      distinctId: "user_123",
      event: "command completed",
      properties: {
        command: "list",
        optional: undefined,
        success: true,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://app.posthog.test/i/v0/e/");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      api_key: "project-token",
      distinct_id: "user_123",
      event: "command completed",
      properties: {
        command: "list",
        success: true,
      },
    });
  });

  test("does nothing when credentials are missing", async () => {
    let called = false;
    const client = createPostHogClient({
      fetchImpl: (async () => {
        called = true;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      host: "",
      projectToken: "",
    });

    await client.capture({
      distinctId: "user_123",
      event: "command completed",
    });

    expect(called).toBe(false);
  });

  test("respects AURA_DISABLE_ANALYTICS=1", async () => {
    const original = process.env.AURA_DISABLE_ANALYTICS;
    process.env.AURA_DISABLE_ANALYTICS = "1";

    let called = false;
    try {
      const client = createPostHogClient({
        fetchImpl: (async () => {
          called = true;
          return new Response(null, { status: 200 });
        }) as unknown as typeof fetch,
        host: "https://app.posthog.test",
        projectToken: "project-token",
      });

      await client.capture({
        distinctId: "user_123",
        event: "command completed",
      });
    } finally {
      if (original === undefined) {
        delete process.env.AURA_DISABLE_ANALYTICS;
      } else {
        process.env.AURA_DISABLE_ANALYTICS = original;
      }
    }

    expect(called).toBe(false);
  });

  test("swallows network failures", async () => {
    const client = createPostHogClient({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      host: "https://app.posthog.test",
      projectToken: "project-token",
    });

    await expect(
      client.capture({
        distinctId: "user_123",
        event: "command completed",
      }),
    ).resolves.toBeUndefined();
  });
});
