import { NextRequest, NextResponse } from "next/server";

// TODO: Once Supabase auth is wired into the dashboard, forward the
// caller's Supabase JWT as `Authorization: Bearer <jwt>` here. The
// FastAPI /recommend endpoint requires a Supabase JWT, so until that
// lands this proxy will surface a 401 from upstream. The network fetch
// itself will succeed; discover-view's empty state handles non-200s.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  const upstream = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/recommend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
