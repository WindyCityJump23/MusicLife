import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type Artist = {
  id: number;
  name: string;
  genres: string[];
  enriched: boolean;
  embedded: boolean;
  image_url: string | null;
};

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

  const tasteSnapshotPromise = sb
    .from("taste_snapshots")
    .select("generated_at,top_genres,anchor_artists,feedback_summary,thesis")
    .eq("user_id", user.userId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle()
    .then((result) => result);

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

  let artists: Artist[] = [];
  if (artistIds.length > 0) {
    // Only select scalar columns — never fetch the embedding vector itself.
    // Downloading 1024 floats × hundreds of artists would be megabytes and
    // can easily timeout. Use scalar enrichment fields here and a separate
    // lightweight query for embedding existence.
    const rows: any[] = [];
    for (const ids of chunk(artistIds)) {
      const { data, error: aErr } = await sb
        .from("artists")
        .select("id, name, genres, musicbrainz_id, lastfm_url, embedding_source")
        .in("id", ids)
        .order("name", { ascending: true });
      if (aErr) {
        return NextResponse.json({ error: aErr.message }, { status: 500 });
      }
      rows.push(...(data ?? []));
    }
    // Check embedding existence without transferring the vector payload.
    const embeddedIds = new Set<number>();
    if (artistIds.length > 0) {
      for (const ids of chunk(artistIds)) {
        const { data: embRows } = await sb
          .from("artists")
          .select("id")
          .in("id", ids)
          .not("embedding", "is", null);
        for (const r of embRows ?? []) {
          embeddedIds.add(r.id);
        }
      }
    }
    artists = (rows ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      genres: r.genres ?? [],
      enriched: Boolean(
        r.musicbrainz_id ||
        r.lastfm_url ||
        r.embedding_source ||
        (Array.isArray(r.genres) && r.genres.length > 0)
      ),
      embedded: embeddedIds.has(r.id),
      image_url: null,
    }));
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

  const { data: tasteSnapshot } = await tasteSnapshotPromise;

  let playableTrackCount = 0;
  let modeledTrackCount = 0;
  for (const ids of chunk(artistIds)) {
    const { count } = await sb
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .in("artist_id", ids)
      .not("spotify_track_id", "is", null);
    playableTrackCount += count ?? 0;

    const { count: modeledCount } = await sb
      .from("tracks")
      .select("id", { count: "exact", head: true })
      .in("artist_id", ids)
      .not("spotify_track_id", "is", null)
      .not("embedding", "is", null);
    modeledTrackCount += modeledCount ?? 0;
  }

  const artistCount = artists.length;
  const enrichedCount = artists.filter((a) => a.enriched).length;
  const embeddedCount = artists.filter((a) => a.embedded).length;
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
          requiredModeledTracks > 0 && modeledTrackCount >= requiredModeledTracks,
      },
    },
    tasteSnapshot: tasteSnapshot ?? null,
    artists,
  });
}
