import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = process.env.TEST_USER_ID;
  if (!userId) {
    return NextResponse.json({ error: "TEST_USER_ID not configured" }, { status: 500 });
  }

  const sb = supabaseServer();

  // Two-step fetch: listen_events → tracks, then tracks → artists.
  // Supabase auto-join via nested select works only when the FK relationship
  // name matches exactly. Fetching separately avoids the silent-null trap.
  const { data: events, error } = await sb
    .from("listen_events")
    .select("id, listened_at, track_id")
    .eq("user_id", userId)
    .order("listened_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const trackIds = Array.from(
    new Set((events ?? []).map((e: any) => e.track_id).filter(Boolean))
  );

  const trackMap: Record<number, { name: string; artistName: string }> = {};
  if (trackIds.length > 0) {
    const { data: tracks } = await sb
      .from("tracks")
      .select("id, name, artist_id")
      .in("id", trackIds);

    const artistIds = Array.from(
      new Set((tracks ?? []).map((t: any) => t.artist_id).filter(Boolean))
    );
    const artistMap: Record<number, string> = {};
    if (artistIds.length > 0) {
      const { data: artists } = await sb
        .from("artists")
        .select("id, name")
        .in("id", artistIds);
      for (const a of artists ?? []) {
        artistMap[a.id] = a.name;
      }
    }

    for (const t of tracks ?? []) {
      trackMap[t.id] = {
        name: t.name ?? "Unknown track",
        artistName: artistMap[t.artist_id] ?? "Unknown artist",
      };
    }
  }

  const plays = (events ?? []).map((row: any) => ({
    id: row.id,
    listenedAt: row.listened_at,
    trackName: trackMap[row.track_id]?.name ?? "Unknown track",
    artistName: trackMap[row.track_id]?.artistName ?? "Unknown artist",
  }));

  return NextResponse.json({ plays });
}
