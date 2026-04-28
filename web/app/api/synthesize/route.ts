import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const userId = process.env.TEST_USER_ID;
  if (!userId) {
    return NextResponse.json({ error: "TEST_USER_ID not configured" }, { status: 500 });
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));

  const upstream = await fetch(
    `${apiUrl}/synthesize/for-artist`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, ...body }),
    }
  );

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
