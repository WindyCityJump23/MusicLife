import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 55;

/**
 * POST /api/recommend-songs
 *
 * Proxies to the Render backend's /recommend/songs endpoint which
 * returns song-level recommendations from the DB (with familiarity
 * penalties, audio features, genre diversity re-ranking).
 */
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
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  let tasteStrategy = body.taste_strategy ?? null;

  if (!prompt && tasteStrategy === null && body.use_taste_strategy !== false) {
    try {
      const { data } = await supabaseServer()
        .from("user_taste_strategy")
        .select("genre_boosts,genre_avoids,discovery_mix,live_expansion,freshness")
        .eq("user_id", user.userId)
        .maybeSingle();
      tasteStrategy = data ?? null;
    } catch (err) {
      console.warn("recommend-songs: taste strategy unavailable", err);
    }
  }

  const upstream = await fetch(`${apiUrl}/recommend/songs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      user_id: user.userId,
      prompt: prompt || null,
      weights: body.weights ?? { affinity: 0.75, context: 0.15, editorial: 0.1 },
      limit: body.limit ?? 30,
      exclude_library: body.exclude_library ?? false,
      discover_run_id: body.discover_run_id ?? null,
      exclude_previously_shown: body.exclude_previously_shown ?? true,
      history_window_runs: body.history_window_runs ?? 15,
      max_allowed_overlap: body.max_allowed_overlap ?? 0,
      novelty_mode: body.novelty_mode ?? "strict",
      taste_strategy: prompt ? null : tasteStrategy,
    }),
  });

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
