import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { hashSessionToken, signConvexJwt } from "../convex/lib/jwt";

describe("Convex JWT helpers", () => {
  test("hashes session tokens deterministically", () => {
    expect(hashSessionToken("session-token")).toBe(hashSessionToken("session-token"));
    expect(hashSessionToken("session-token")).not.toBe(hashSessionToken("other-token"));
  });

  test("signs a JWT with the expected claims", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const pem = privateKey.export({
      format: "pem",
      type: "pkcs8",
    });

    const signed = signConvexJwt(
      {
        userId: "user_123",
        email: "teammate@example.com",
        name: "Teammate",
        picture: "https://example.com/picture.png",
        sessionId: "session_123",
      },
      {
        issuer: "https://issuer.example.com",
        audience: "convex-audience",
        privateKeyPem: String(pem),
        keyId: "kid_123",
        now: new Date("2026-03-23T12:00:00.000Z"),
      },
    );

    const [, payload] = signed.token.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as {
      iss: string;
      aud: string;
      sub: string;
      email: string;
      properties: {
        sessionId: string;
      };
    };

    expect(decoded.iss).toBe("https://issuer.example.com");
    expect(decoded.aud).toBe("convex-audience");
    expect(decoded.sub).toBe("user_123");
    expect(decoded.email).toBe("teammate@example.com");
    expect(decoded.properties.sessionId).toBe("session_123");
    expect(signed.expiresAt).toBe("2026-03-23T12:15:00.000Z");
  });

  test("defaults audience from NODE_ENV when not provided", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const pem = privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    const originalEnv = {
      AURA_AUTH_AUDIENCE: process.env.AURA_AUTH_AUDIENCE,
      NODE_ENV: process.env.NODE_ENV,
    };

    delete process.env.AURA_AUTH_AUDIENCE;
    process.env.NODE_ENV = "production";

    try {
      const signed = signConvexJwt(
        {
          userId: "user_123",
          email: "teammate@example.com",
        },
        {
          issuer: "https://issuer.example.com",
          privateKeyPem: String(pem),
          keyId: "kid_123",
          now: new Date("2026-03-23T12:00:00.000Z"),
        },
      );
      const [, payload] = signed.token.split(".");
      const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as {
        aud: string;
      };

      expect(decoded.aud).toBe("aura-cli-prod");
    } finally {
      if (originalEnv.AURA_AUTH_AUDIENCE === undefined) {
        delete process.env.AURA_AUTH_AUDIENCE;
      } else {
        process.env.AURA_AUTH_AUDIENCE = originalEnv.AURA_AUTH_AUDIENCE;
      }

      if (originalEnv.NODE_ENV === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalEnv.NODE_ENV;
      }
    }
  });
});
