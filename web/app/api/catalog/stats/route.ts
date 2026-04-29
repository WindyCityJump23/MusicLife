import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/catalog/stats
 *
 * Surfaces the three numbers the sidebar needs to show users that the
 * catalog isn't a one-and-done thing:
 *   - library: distinct artists from the user's listening history
 *   - discovered: catalog-wide artists with no spotify_artist_id, i.e.
 *     ones added by the Last.fm "similar artists" expansion pass
 *   - embedded: artists with a non-null embedding (across the catalog)
 */
export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();

  // Library: distinct artist_ids reachable from the user's user_tracks.
  const { data: userTracks } = await sb
    .from("user_tracks")
    .select("track_id, tracks(artist_id)")
    .eq("user_id", user.userId);

  const libraryArtistIds = new Set<number>();
  for (const row of userTracks ?? []) {
    const aid = (row as any).tracks?.artist_id;
    if (typeof aid === "number") libraryArtistIds.add(aid);
  }

  // Discovered: catalog-wide artists with no Spotify ID (Last.fm-expanded).
  const { count: discoveredCount } = await sb
    .from("artists")
    .select("id", { count: "exact", head: true })
    .is("spotify_artist_id", null);

  // Embedded: catalog-wide artists with embedding != null.
  const { count: embeddedCount } = await sb
    .from("artists")
    .select("id", { count: "exact", head: true })
    .not("embedding", "is", null);

  return NextResponse.json({
    library: libraryArtistIds.size,
    discovered: discoveredCount ?? 0,
    embedded: embeddedCount ?? 0,
  });
}
