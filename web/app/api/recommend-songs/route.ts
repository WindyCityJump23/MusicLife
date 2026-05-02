import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

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

  const upstream = await fetch(`${apiUrl}/recommend/songs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      user_id: user.userId,
      prompt: body.prompt ?? null,
      weights: body.weights ?? { affinity: 0.4, context: 0.4, editorial: 0.2 },
      limit: body.limit ?? 30,
      discover_run_id: body.discover_run_id ?? null,
      exclude_previously_shown: body.exclude_previously_shown ?? true,
      history_window_runs: body.history_window_runs ?? 15,
      max_allowed_overlap: body.max_allowed_overlap ?? 0,
      novelty_mode: body.novelty_mode ?? "strict",
    }),
  });

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
