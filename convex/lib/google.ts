export interface GoogleUserProfile {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

export async function fetchGoogleUserProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleUserProfile> {
  const response = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Google userinfo request failed with ${response.status}: ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };

  if (!payload.sub || !payload.email) {
    throw new Error("Google userinfo response did not include a stable subject and email.");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}
