import type { PostHogClient } from "../../src/core/analytics/posthog";

export interface AuthAnalyticsUser {
  email: string;
  id: string;
}

export interface GoogleLoginAnalyticsInput {
  cliVersion?: string;
  isNewUser: boolean;
  loginAt: string;
  platform?: string;
  user: AuthAnalyticsUser;
  userAgent?: string;
}

export async function captureSuccessfulGoogleLogin(
  client: PostHogClient,
  input: GoogleLoginAnalyticsInput,
): Promise<void> {
  const properties = {
    auth_provider: "google",
    cli_version: input.cliVersion,
    email_domain: extractEmailDomain(input.user.email),
    login_at: input.loginAt,
    platform: input.platform,
    user_agent: input.userAgent,
  };

  if (input.isNewUser) {
    await client.capture({
      distinctId: input.user.id,
      event: "user signed up",
      properties,
    });
  }

  await client.capture({
    distinctId: input.user.id,
    event: "user logged in",
    properties,
  });
}

function extractEmailDomain(email: string): string | undefined {
  const [, domain] = email.split("@");
  return domain || undefined;
}
