import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/library/track-ids
 *
 * Returns every Spotify track ID currently in the user's library
 * (anything in user_tracks). Used by Discover to filter out songs the
 * user already owns — library artists are still recommendable, but their
 * already-saved songs should never surface in Discover results.
 */
export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();

  const { data, error } = await sb
    .from("user_tracks")
    .select("tracks(spotify_track_id)")
    .eq("user_id", user.userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const ids = Array.from(
    new Set(
      (data ?? [])
        .map((row: any) => row.tracks?.spotify_track_id)
        .filter((id: string | null | undefined): id is string => typeof id === "string" && id.length > 0)
    )
  );

  return NextResponse.json({ spotify_track_ids: ids });
}
