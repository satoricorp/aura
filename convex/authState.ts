import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const upsertGoogleUser = mutationGeneric({
  args: {
    googleSubject: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    picture: v.optional(v.string()),
    loggedInAt: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_google_subject", (query) => query.eq("googleSubject", args.googleSubject))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email,
        lastLoginAt: args.loggedInAt,
        name: args.name,
        picture: args.picture,
      });

      return {
        isNewUser: false,
        user: {
          convexUserId: existing._id,
          id: String(existing._id),
          email: args.email,
          name: args.name,
          picture: args.picture,
        },
      };
    }

    const userId = await ctx.db.insert("users", {
      googleSubject: args.googleSubject,
      email: args.email,
      name: args.name,
      picture: args.picture,
      firstLoginAt: args.loggedInAt,
      lastLoginAt: args.loggedInAt,
    });

    return {
      isNewUser: true,
      user: {
        convexUserId: userId,
        id: String(userId),
        email: args.email,
        name: args.name,
        picture: args.picture,
      },
    };
  },
});

export const createSessionRecord = mutationGeneric({
  args: {
    userId: v.id("users"),
    tokenHash: v.string(),
    createdAt: v.string(),
    lastUsedAt: v.string(),
    userAgent: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("sessions", {
      userId: args.userId,
      tokenHash: args.tokenHash,
      createdAt: args.createdAt,
      lastUsedAt: args.lastUsedAt,
      userAgent: args.userAgent,
      platform: args.platform,
    });
  },
});

export const getActiveSessionByTokenHash = queryGeneric({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token_hash", (query) => query.eq("tokenHash", args.tokenHash))
      .unique();

    if (!session || session.revokedAt) {
      return null;
    }

    const user = await ctx.db.get(session.userId);
    if (!user) {
      return null;
    }

    return {
      convexSessionId: session._id,
      sessionId: String(session._id),
      user: {
        id: String(user._id),
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
    };
  },
});

export const touchSession = mutationGeneric({
  args: {
    sessionId: v.id("sessions"),
    lastUsedAt: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      lastUsedAt: args.lastUsedAt,
    });
  },
});

export const revokeSessionByTokenHash = mutationGeneric({
  args: {
    tokenHash: v.string(),
    revokedAt: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token_hash", (query) => query.eq("tokenHash", args.tokenHash))
      .unique();

    if (!session || session.revokedAt) {
      return;
    }

    await ctx.db.patch(session._id, {
      revokedAt: args.revokedAt,
    });
  },
});
