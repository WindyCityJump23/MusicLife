import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = process.env.TEST_USER_ID;
  if (!userId) {
    return NextResponse.json({ error: "TEST_USER_ID not configured" }, { status: 500 });
  }

  const sb = supabaseServer();

  const { data, error } = await sb
    .from("listen_events")
    .select("id, listened_at, tracks(name, artists(name))")
    .eq("user_id", userId)
    .order("listened_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const plays = (data ?? []).map((row: any) => ({
    id: row.id,
    listenedAt: row.listened_at,
    trackName: row.tracks?.name ?? "Unknown track",
    artistName: row.tracks?.artists?.name ?? "Unknown artist",
  }));

  return NextResponse.json({ plays });
}
