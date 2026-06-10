import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import {
  getSessionUser,
  isErrorResponse,
  isGuestUser,
  requireUser,
} from "./session";

/** Minimal NextRequest stub exposing only the cookie API the helpers use. */
function reqWithCookies(cookies: Record<string, string>): NextRequest {
  return {
    cookies: {
      get: (name: string) =>
        name in cookies ? { name, value: cookies[name] } : undefined,
    },
  } as unknown as NextRequest;
}

describe("getSessionUser", () => {
  it("returns null when no app_user_id cookie is present", () => {
    expect(getSessionUser(reqWithCookies({}))).toBeNull();
  });

  it("reads the user id, decoded display name, and auth type", () => {
    const user = getSessionUser(
      reqWithCookies({
        app_user_id: "u-123",
        app_display_name: encodeURIComponent("Jane Doe"),
        app_auth_type: "spotify",
      })
    );
    expect(user).toEqual({
      userId: "u-123",
      displayName: "Jane Doe",
      authType: "spotify",
    });
  });

  it("defaults display name and auth type when absent", () => {
    const user = getSessionUser(reqWithCookies({ app_user_id: "u-1" }));
    expect(user?.displayName).toBe("Listener");
    expect(user?.authType).toBe("spotify");
  });

  it("recognizes playlist_import guests", () => {
    const user = getSessionUser(
      reqWithCookies({ app_user_id: "g-1", app_auth_type: "playlist_import" })
    );
    expect(user?.authType).toBe("playlist_import");
    expect(user && isGuestUser(user)).toBe(true);
  });
});

describe("requireUser / isErrorResponse", () => {
  it("returns a 401 response when unauthenticated", async () => {
    const result = requireUser(reqWithCookies({}));
    expect(isErrorResponse(result)).toBe(true);
    if (isErrorResponse(result)) {
      expect(result.status).toBe(401);
      const body = await result.json();
      expect(body.error).toBe("not_authenticated");
    }
  });

  it("returns the session user when authenticated", () => {
    const result = requireUser(reqWithCookies({ app_user_id: "u-9" }));
    expect(isErrorResponse(result)).toBe(false);
    if (!isErrorResponse(result)) {
      expect(result.userId).toBe("u-9");
    }
  });
});
