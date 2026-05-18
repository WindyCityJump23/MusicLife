import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 25; // Render backend can take 8-10s; free tier caps at 10s
const UPSTREAM_TIMEOUT_MS = 12_000;

export async function GET() {
  return NextResponse.json(
    { error: "Use POST /api/recommend for artist discovery." },
    { status: 405 }
  );
}

export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${apiUrl}/recommend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({ user_id: user.userId, ...body }),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    console.warn(
      timedOut
        ? "recommend: upstream artist search timed out; client should continue with song fallback"
        : "recommend: upstream artist search failed; client should continue with song fallback",
      err
    );
    return NextResponse.json(
      {
        error: timedOut
          ? "Artist search timed out; continue with song fallback."
          : "Artist search failed; continue with song fallback.",
      },
      { status: timedOut ? 504 : 502 }
    );
  } finally {
    clearTimeout(timeout);
  }

  const data = await upstream.json().catch(() => ({}));
  console.info("recommend: upstream response", {
    status: upstream.status,
    prompt: typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null,
    result_count: Array.isArray(data.results) ? data.results.length : 0,
  });
  return NextResponse.json(data, { status: upstream.status });
}
