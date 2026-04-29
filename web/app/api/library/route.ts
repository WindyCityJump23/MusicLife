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

export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();

  const { data: userTracks, error: utErr, count: utCount } = await sb
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
    // can easily timeout. Instead use embedding_source as the enriched proxy
    // and a cast to check if embedding is non-null without transferring it.
    const { data: rows, error: aErr } = await sb
      .from("artists")
      .select("id, name, genres, musicbrainz_id, embedding_source")
      .in("id", artistIds)
      .order("name", { ascending: true });
    if (aErr) {
      return NextResponse.json({ error: aErr.message }, { status: 500 });
    }
    // We can't easily check embedding != null without fetching it.
    // Instead, if embedding_source is set, the artist was enriched and is
    // eligible for embedding. We'll do a separate lightweight check.
    const embeddedIds = new Set<number>();
    if (artistIds.length > 0) {
      const { data: embRows } = await sb
        .from("artists")
        .select("id")
        .in("id", artistIds)
        .not("embedding", "is", null);
      for (const r of embRows ?? []) {
        embeddedIds.add(r.id);
      }
    }
    artists = (rows ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      genres: r.genres ?? [],
      enriched: Boolean(r.musicbrainz_id),
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

  return NextResponse.json({
    stats: {
      artistCount: artists.length,
      trackCount: userTracks?.length ?? 0,
      catalogTrackCount: catalogTrackCount ?? 0,
      recentPlayCount: Math.min(recentPlayCount ?? 0, 50),
      mentionCount: mentionCount ?? 0,
    },
    artists,
  });
}
