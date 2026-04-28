import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const userId = process.env.TEST_USER_ID;
  if (!userId) {
    return NextResponse.json({ error: "TEST_USER_ID not configured" }, { status: 500 });
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }

  // Always go through /api/auth/token so we get a fresh (auto-refreshed) token
  // rather than reading the potentially-expired sp_access cookie directly.
  const tokenRes = await fetch(
    new URL("/api/auth/token", req.url).toString(),
    { headers: { cookie: req.headers.get("cookie") ?? "" }, cache: "no-store" }
  );
  if (!tokenRes.ok) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const { access_token: accessToken } = await tokenRes.json();
  if (!accessToken) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const upstream = await fetch(
    `${apiUrl}/ingest/spotify-library`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, spotify_access_token: accessToken }),
    }
  );

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
