import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

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
  const strategy = body.taste_strategy ?? null;

  const upstream = await fetch(`${apiUrl}/recommend/songs/live-intents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      user_id: user.userId,
      prompt: body.prompt ?? null,
      limit: body.limit ?? 8,
      genre_boosts: Array.isArray(strategy?.genre_boosts) ? strategy.genre_boosts : [],
      genre_avoids: Array.isArray(strategy?.genre_avoids) ? strategy.genre_avoids : [],
      freshness: strategy?.freshness ?? "balanced",
    }),
  });

  const data = await upstream.json().catch(() => ({}));
  console.info("live-candidate-intents: upstream response", {
    status: upstream.status,
    prompt: typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null,
    intent_count: Array.isArray(data.intents) ? data.intents.length : 0,
    source: data.source ?? null,
  });
  return NextResponse.json(data, { status: upstream.status });
}
