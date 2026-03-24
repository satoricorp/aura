import * as p from "@clack/prompts";
import { createAuthService, type CreateAuthServiceOptions } from "../../core/auth/service";

export async function runLogout(options: CreateAuthServiceOptions = {}): Promise<void> {
  const authService = createAuthService(options);
  const removed = await authService.logout();

  if (!removed) {
    p.log.warn("No saved Aura login was found on this system.");
    return;
  }

  p.log.success("Signed out and removed the saved local session.");
}
