import { createAuthService, type CreateAuthServiceOptions } from "../../core/auth/service";

export async function runWhoAmI(options: CreateAuthServiceOptions = {}): Promise<void> {
  const authService = createAuthService(options);
  console.log(await formatCurrentAuth(authService));
}

export async function formatCurrentAuth(authService = createAuthService()): Promise<string> {
  const status = await authService.getStatus();

  if (!status.authenticated || !status.authState) {
    return `Not signed in.\nConfig: ${status.path}`;
  }

  return [
    `Signed in as ${status.authState.user.email}`,
    `User ID: ${status.authState.user.id}`,
    `JWT: ${status.needsRefresh ? "expired, will refresh on next command" : "fresh"}`,
    `Config: ${status.path}`,
  ].join("\n");
}
