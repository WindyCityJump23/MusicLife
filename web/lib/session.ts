/**
 * Session helpers — resolve the current user from HTTP-only cookies.
 *
 * On Spotify OAuth callback the user is upserted into Supabase and their
 * UUID is stored in the app_user_id cookie. Every subsequent request reads
 * that cookie — no Spotify API call on each request.
 */

import { NextRequest, NextResponse } from "next/server";

export type SessionUser = {
  userId: string;       // Supabase UUID
  displayName: string;
};

/** Returns the session user or null if not authenticated. */
export function getSessionUser(req: NextRequest): SessionUser | null {
  const userId = req.cookies.get("app_user_id")?.value;
  const displayName = req.cookies.get("app_display_name")?.value;

  if (!userId) return null;

  return {
    userId,
    displayName: displayName ? decodeURIComponent(displayName) : "Listener",
  };
}

/** Require auth — returns user or a 401 JSON response. */
export function requireUser(
  req: NextRequest
): SessionUser | NextResponse {
  const user = getSessionUser(req);
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  return user;
}

/** Type guard — true when requireUser returned an error response. */
export function isErrorResponse(
  val: SessionUser | NextResponse
): val is NextResponse {
  return val instanceof NextResponse;
}
