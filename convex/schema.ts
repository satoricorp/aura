import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    googleSubject: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    picture: v.optional(v.string()),
    firstLoginAt: v.string(),
    lastLoginAt: v.string(),
  })
    .index("by_google_subject", ["googleSubject"])
    .index("by_email", ["email"]),

  sessions: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(),
    createdAt: v.string(),
    lastUsedAt: v.string(),
    revokedAt: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    platform: v.optional(v.string()),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_user_id", ["userId"]),
});
