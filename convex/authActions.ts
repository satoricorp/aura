"use node";

import { anyApi, actionGeneric } from "convex/server";
import { v } from "convex/values";
import { fetchGoogleUserProfile } from "./lib/google";
import { createSessionToken, hashSessionToken, signConvexJwt } from "./lib/jwt";

export const exchangeGoogleLogin = actionGeneric({
  args: {
    accessToken: v.string(),
    idToken: v.optional(v.string()),
    platform: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const googleProfile = await fetchGoogleUserProfile(args.accessToken);
    const user = await ctx.runMutation(anyApi.authState.upsertGoogleUser, {
      googleSubject: googleProfile.sub,
      email: googleProfile.email,
      name: googleProfile.name,
      picture: googleProfile.picture,
      loggedInAt: now,
    });

    const sessionToken = createSessionToken();
    const sessionId = await ctx.runMutation(anyApi.authState.createSessionRecord, {
      userId: user.convexUserId,
      tokenHash: hashSessionToken(sessionToken),
      createdAt: now,
      lastUsedAt: now,
      platform: args.platform,
      userAgent: args.userAgent,
    });
    const jwt = signConvexJwt({
      userId: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      sessionId: String(sessionId),
    });

    return {
      sessionToken,
      convexJwt: jwt.token,
      convexJwtExpiresAt: jwt.expiresAt,
      user,
      lastLoginAt: now,
      lastRefreshAt: now,
    };
  },
});

export const refreshSession = actionGeneric({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const tokenHash = hashSessionToken(args.sessionToken);
    const session = await ctx.runQuery(anyApi.authState.getActiveSessionByTokenHash, {
      tokenHash,
    });

    if (!session) {
      throw new Error("Session expired or revoked. Please sign in again.");
    }

    const now = new Date().toISOString();
    await ctx.runMutation(anyApi.authState.touchSession, {
      sessionId: session.convexSessionId,
      lastUsedAt: now,
    });

    const jwt = signConvexJwt({
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      picture: session.user.picture,
      sessionId: session.sessionId,
    });

    return {
      sessionToken: args.sessionToken,
      convexJwt: jwt.token,
      convexJwtExpiresAt: jwt.expiresAt,
      user: session.user,
      lastRefreshAt: now,
    };
  },
});

export const logoutSession = actionGeneric({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(anyApi.authState.revokeSessionByTokenHash, {
      tokenHash: hashSessionToken(args.sessionToken),
      revokedAt: new Date().toISOString(),
    });
  },
});
