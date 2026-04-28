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

  // The FastAPI /recommend endpoint validates a Supabase JWT. Until the
  // dashboard has full Supabase auth, we use the service role key as the
  // bearer token — it bypasses RLS the same way the API's admin client does.
  // This is safe because the route is server-side only and the key never
  // reaches the browser.
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));

  const upstream = await fetch(
    `${apiUrl}/recommend`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ user_id: userId, ...body }),
    }
  );

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
