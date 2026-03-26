import { describe, expect, test } from "bun:test";
import { captureSuccessfulGoogleLogin } from "../convex/lib/authAnalytics";
import type { PostHogCaptureRequest, PostHogClient } from "../src/core/analytics/posthog";

describe("captureSuccessfulGoogleLogin", () => {
  test("captures signup and login for a brand-new user", async () => {
    const client = new FakePostHogClient();

    await captureSuccessfulGoogleLogin(client, {
      cliVersion: "1.2.3",
      isNewUser: true,
      loginAt: "2026-03-23T12:00:00.000Z",
      platform: "darwin",
      user: {
        id: "user_123",
        email: "teammate@example.com",
      },
      userAgent: "aura/1.2.3",
    });

    expect(client.captures).toEqual([
      {
        distinctId: "user_123",
        event: "user signed up",
        properties: {
          auth_provider: "google",
          cli_version: "1.2.3",
          email_domain: "example.com",
          login_at: "2026-03-23T12:00:00.000Z",
          platform: "darwin",
          user_agent: "aura/1.2.3",
        },
      },
      {
        distinctId: "user_123",
        event: "user logged in",
        properties: {
          auth_provider: "google",
          cli_version: "1.2.3",
          email_domain: "example.com",
          login_at: "2026-03-23T12:00:00.000Z",
          platform: "darwin",
          user_agent: "aura/1.2.3",
        },
      },
    ]);
  });

  test("captures only login for an existing user", async () => {
    const client = new FakePostHogClient();

    await captureSuccessfulGoogleLogin(client, {
      isNewUser: false,
      loginAt: "2026-03-23T12:00:00.000Z",
      user: {
        id: "user_123",
        email: "teammate@example.com",
      },
    });

    expect(client.captures).toEqual([
      {
        distinctId: "user_123",
        event: "user logged in",
        properties: {
          auth_provider: "google",
          email_domain: "example.com",
          login_at: "2026-03-23T12:00:00.000Z",
        },
      },
    ]);
  });
});

class FakePostHogClient implements PostHogClient {
  readonly enabled = true;
  readonly captures: PostHogCaptureRequest[] = [];

  async capture(request: PostHogCaptureRequest): Promise<void> {
    this.captures.push(request);
  }
}
