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
};

export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();

  const { data: userTracks, error: utErr } = await sb
    .from("user_tracks")
    .select("track_id, tracks(artist_id)")
    .eq("user_id", user.userId);

  if (utErr) {
    return NextResponse.json({ error: utErr.message }, { status: 500 });
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
    const { data: rows, error: aErr } = await sb
      .from("artists")
      .select("id, name, genres, musicbrainz_id, embedding")
      .in("id", artistIds)
      .order("name", { ascending: true });
    if (aErr) {
      return NextResponse.json({ error: aErr.message }, { status: 500 });
    }
    artists = (rows ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      genres: r.genres ?? [],
      enriched: Boolean(r.musicbrainz_id),
      embedded: r.embedding != null,
    }));
  }

  const { count: recentPlayCount } = await sb
    .from("listen_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.userId)
    .order("listened_at", { ascending: false })
    .limit(50);

  return NextResponse.json({
    stats: {
      artistCount: artists.length,
      trackCount: userTracks?.length ?? 0,
      recentPlayCount: Math.min(recentPlayCount ?? 0, 50),
    },
    artists,
  });
}
