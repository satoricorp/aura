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

export interface MemkitConfigRecord {
  auth?: AuthState;
  [key: string]: unknown;
}

export interface LoadedMemkitConfig {
  auth?: AuthState;
  config: MemkitConfigRecord;
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
  exchangeGoogleLogin(proof: GoogleIdentityProof): Promise<AuthState>;
  refreshSession(sessionToken: string): Promise<AuthState>;
  logoutSession(sessionToken: string): Promise<void>;
}

export interface MemkitConfigStore {
  load(): Promise<LoadedMemkitConfig>;
  saveAuthState(authState: AuthState, currentConfig?: MemkitConfigRecord): Promise<void>;
  clearAuthState(currentConfig?: MemkitConfigRecord): Promise<void>;
}

export interface AuthService {
  ensureAuthenticated(): Promise<AuthState>;
  login(): Promise<AuthState>;
  logout(): Promise<boolean>;
  getStatus(): Promise<AuthStatus>;
}
