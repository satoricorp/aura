export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface AuthState {
  sessionToken: string;
  convexJwt: string;
  convexJwtExpiresAt: string;
  user: AuthUser;
  lastLoginAt?: string;
  lastRefreshAt?: string;
}

export interface GoogleIdentityProof {
  accessToken: string;
  idToken?: string;
}

export interface GoogleLoginExchangePayload extends GoogleIdentityProof {
  cliVersion?: string;
  platform?: string;
  userAgent?: string;
}

export interface AuraConfigRecord {
  auth?: AuthState;
  [key: string]: unknown;
}

export interface LoadedAuraConfig {
  auth?: AuthState;
  config: AuraConfigRecord;
  exists: boolean;
  malformed: boolean;
  path: string;
}

export interface AuthStatus {
  authenticated: boolean;
  authState?: AuthState;
  needsRefresh: boolean;
  path: string;
}

export interface GoogleOAuthClient {
  authenticate(): Promise<GoogleIdentityProof>;
}

export interface ConvexAuthClient {
  exchangeGoogleLogin(proof: GoogleLoginExchangePayload): Promise<AuthState>;
  refreshSession(sessionToken: string): Promise<AuthState>;
  logoutSession(sessionToken: string): Promise<void>;
}

export interface AuraConfigStore {
  load(): Promise<LoadedAuraConfig>;
  saveAuthState(authState: AuthState, currentConfig?: AuraConfigRecord): Promise<void>;
  deleteConfigFile(): Promise<void>;
}

export interface AuthService {
  ensureAuthenticated(): Promise<AuthState>;
  login(): Promise<AuthState>;
  logout(): Promise<boolean>;
  getStatus(): Promise<AuthStatus>;
}
