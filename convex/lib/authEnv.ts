export function resolveAuthAudience(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AURA_AUTH_AUDIENCE ?? (env.NODE_ENV === "production" ? "aura-cli-prod" : "aura-cli-dev")
  );
}
