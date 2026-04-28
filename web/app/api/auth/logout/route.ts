import { NextResponse } from "next/server";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  const clear = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 0 };
  res.cookies.set("sp_access", "", clear);
  res.cookies.set("sp_access_expires_at", "", clear);
  res.cookies.set("sp_refresh", "", clear);
  res.cookies.set("sp_oauth_state", "", clear);
  res.cookies.set("app_user_id", "", clear);
  res.cookies.set("app_display_name", "", clear);
  return res;
}
