import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * GET /api/favorites-check?ids=id1,id2,id3
 *
 * Returns which of the given Spotify track IDs are favorited by the current user.
 * Response: { favorited: string[] }
 */
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  const { searchParams } = new URL(request.url);
  const idsParam = searchParams.get("ids");

  if (!idsParam) {
    return NextResponse.json({ favorited: [] });
  }

  const ids = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return NextResponse.json({ favorited: [] });
  }

  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );

    const { data } = await sb
      .from("user_favorites")
      .select("spotify_track_id")
      .eq("user_id", user.userId)
      .in("spotify_track_id", ids);

    const favorited = (data ?? []).map(
      (r: { spotify_track_id: string }) => r.spotify_track_id
    );
    return NextResponse.json({ favorited });
  } catch {
    return NextResponse.json(
      { error: "Failed to check favorites" },
      { status: 500 }
    );
  }
}
