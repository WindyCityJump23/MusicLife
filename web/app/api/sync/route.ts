import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const accessToken = req.cookies.get("sp_access")?.value;
  if (!accessToken) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const userId = process.env.TEST_USER_ID;
  if (!userId) {
    return NextResponse.json({ error: "TEST_USER_ID not configured" }, { status: 500 });
  }

  const upstream = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/ingest/spotify-library`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, spotify_access_token: accessToken }),
    }
  );

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
