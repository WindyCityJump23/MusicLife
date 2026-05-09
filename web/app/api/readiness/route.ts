import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const QUERY_CHUNK_SIZE = 200;

function chunk<T>(items: T[], size = QUERY_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function requiredArtistCount(artistCount: number): number {
  if (artistCount <= 0) return 0;
  return Math.min(artistCount, Math.max(5, Math.ceil(artistCount * 0.25)));
}

function requiredPlayableTrackCount(artistCount: number, requiredArtists: number): number {
  if (artistCount <= 0) return 0;
  return Math.min(50, Math.max(10, requiredArtists * 3));
}

export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();

  const { data: userTracks, error: utErr } = await sb
    .from("user_tracks")
    .select("track_id, tracks(artist_id)", { count: "exact" })
    .eq("user_id", user.userId);

  if (utErr) {
    return NextResponse.json({ error: utErr.message, debug_user_id: user.userId }, { status: 500 });
  }

  const artistIds = Array.from(
    new Set(
      (userTracks ?? [])
        .map((row: any) => row.tracks?.artist_id)
        .filter((id: number | null | undefined): id is number => typeof id === "number")
    )
  );

  let enrichedCount = 0;
  let embeddedCount = 0;
  let playableTrackCount = 0;
  let modeledTrackCount = 0;

  for (const ids of chunk(artistIds)) {
    const { data: artistRows, error: artistErr } = await sb
      .from("artists")
      .select("id, genres, musicbrainz_id, lastfm_url, embedding_source")
      .in("id", ids);
    if (artistErr) {
      return NextResponse.json({ error: artistErr.message }, { status: 500 });
    }

    enrichedCount += (artistRows ?? []).filter((row: any) =>
      Boolean(
        row.musicbrainz_id ||
          row.lastfm_url ||
          row.embedding_source ||
          (Array.isArray(row.genres) && row.genres.length > 0)
      )
    ).length;

    const { count: embeddedChunkCount } = await sb
      .from("artists")
      .select("id", { count: "exact", head: true })
      .in("id", ids)
      .not("embedding", "is", null);
    embeddedCount += embeddedChunkCount ?? 0;

    const { count: playableChunkCount } = await sb
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .in("artist_id", ids)
      .not("spotify_track_id", "is", null);
    playableTrackCount += playableChunkCount ?? 0;

    const { count: modeledChunkCount } = await sb
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .in("artist_id", ids)
      .not("spotify_track_id", "is", null)
      .not("embedding", "is", null);
    modeledTrackCount += modeledChunkCount ?? 0;
  }

  const { count: recentPlayCount } = await sb
    .from("listen_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.userId)
    .order("listened_at", { ascending: false })
    .limit(50);

  const { count: mentionCount } = await sb
    .from("mentions")
    .select("id", { count: "exact", head: true });

  const { count: catalogTrackCount } = await sb
    .from("tracks")
    .select("id", { count: "exact", head: true });

  const { count: discoveredCount } = await sb
    .from("artists")
    .select("id", { count: "exact", head: true })
    .is("spotify_artist_id", null);

  const { count: embeddedCatalogCount } = await sb
    .from("artists")
    .select("id", { count: "exact", head: true })
    .not("embedding", "is", null);

  const artistCount = artistIds.length;
  const requiredArtists = requiredArtistCount(artistCount);
  const requiredPlayableTracks = requiredPlayableTrackCount(artistCount, requiredArtists);
  const requiredModeledTracks = Math.min(requiredPlayableTracks, playableTrackCount);
  const radioReady =
    artistCount > 0 &&
    enrichedCount >= requiredArtists &&
    embeddedCount >= requiredArtists &&
    playableTrackCount >= requiredPlayableTracks;

  return NextResponse.json({
    stats: {
      artistCount,
      trackCount: userTracks?.length ?? 0,
      catalogTrackCount: catalogTrackCount ?? 0,
      playableTrackCount,
      modeledTrackCount,
      recentPlayCount: Math.min(recentPlayCount ?? 0, 50),
      mentionCount: mentionCount ?? 0,
    },
    catalogStats: {
      library: artistCount,
      discovered: discoveredCount ?? 0,
      embedded: embeddedCatalogCount ?? 0,
    },
    readiness: {
      radioReady,
      requiredArtistCount: requiredArtists,
      requiredPlayableTrackCount: requiredPlayableTracks,
      requiredModeledTrackCount: requiredModeledTracks,
      enrichedCount,
      embeddedCount,
      playableTrackCount,
      modeledTrackCount,
      steps: {
        imported: artistCount > 0,
        enriched: artistCount > 0 && enrichedCount >= requiredArtists,
        embedded: artistCount > 0 && embeddedCount >= requiredArtists,
        context: (mentionCount ?? 0) > 0,
        tracks: artistCount > 0 && playableTrackCount >= requiredPlayableTracks,
        modeledTracks:
          playableTrackCount > 0
            ? modeledTrackCount >= Math.max(1, requiredModeledTracks)
            : false,
      },
    },
  });
}
