import { describe, expect, it } from "vitest";
import { mintSupabaseJwt, verifySupabaseJwt } from "./supabase-jwt";

const SECRET = "test-jwt-secret-do-not-use-in-prod";

describe("mintSupabaseJwt", () => {
  it("produces a three-part HS256 token with the expected claims", () => {
    const token = mintSupabaseJwt("user-uuid-1", SECRET, { expiresInSeconds: 60 });
    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });

    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(claims.sub).toBe("user-uuid-1");
    expect(claims.role).toBe("authenticated");
    expect(claims.aud).toBe("authenticated");
    expect(claims.exp - claims.iat).toBe(60);
  });

  it("requires a userId and secret", () => {
    expect(() => mintSupabaseJwt("", SECRET)).toThrow();
    expect(() => mintSupabaseJwt("u", "")).toThrow();
  });
});

describe("verifySupabaseJwt", () => {
  it("round-trips a freshly minted token", () => {
    const token = mintSupabaseJwt("user-9", SECRET);
    const claims = verifySupabaseJwt(token, SECRET);
    expect(claims?.sub).toBe("user-9");
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintSupabaseJwt("user-9", SECRET);
    expect(verifySupabaseJwt(token, "other-secret")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = mintSupabaseJwt("user-9", SECRET);
    const [h, , s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: "admin" })).toString("base64url")}.${s}`;
    expect(verifySupabaseJwt(forged, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = mintSupabaseJwt("user-9", SECRET, { expiresInSeconds: -10 });
    expect(verifySupabaseJwt(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifySupabaseJwt("not-a-jwt", SECRET)).toBeNull();
  });
});
