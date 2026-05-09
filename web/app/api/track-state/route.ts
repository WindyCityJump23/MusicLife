import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * GET /api/track-state?ids=id1,id2,id3
 *
 * Returns per-track saved and feedback state for the current user.
 * Response: { favorited: string[], feedback: { [spotify_track_id: string]: 1 | -1 } }
 */
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  const { searchParams } = new URL(request.url);
  const ids = (searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return NextResponse.json({ favorited: [], feedback: {} });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error("track-state: missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL");
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  try {
    const sb = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // PostgREST has a URL length limit; cap at 200 IDs per query.
    const queryIds = ids.slice(0, 200);

    const [favoritesResult, feedbackResult] = await Promise.all([
      sb
        .from("user_favorites")
        .select("spotify_track_id")
        .eq("user_id", user.userId)
        .in("spotify_track_id", queryIds),
      sb
        .from("user_feedback")
        .select("spotify_track_id,feedback")
        .eq("user_id", user.userId)
        .in("spotify_track_id", queryIds),
    ]);

    if (favoritesResult.error) throw favoritesResult.error;
    if (feedbackResult.error) throw feedbackResult.error;

    const favorited = (favoritesResult.data ?? []).map(
      (row: { spotify_track_id: string }) => row.spotify_track_id
    );
    const feedback: Record<string, 1 | -1> = {};
    for (const row of feedbackResult.data ?? []) {
      feedback[row.spotify_track_id] = row.feedback;
    }

    return NextResponse.json({ favorited, feedback });
  } catch (err) {
    console.error("track-state: query failed", err);
    return NextResponse.json(
      { error: "Failed to check track state" },
      { status: 500 }
    );
  }
}
