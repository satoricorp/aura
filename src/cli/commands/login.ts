import * as p from "@clack/prompts";
import { createAuthService, type CreateAuthServiceOptions } from "../../core/auth/service";

export async function runLogin(options: CreateAuthServiceOptions = {}): Promise<void> {
  const authService = createAuthService(options);
  const authState = await authService.login();
  p.log.success(`Signed in as ${authState.user.email}.`);
}
