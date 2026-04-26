import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = process.env.TEST_USER_ID;
  if (!userId) {
    return NextResponse.json({ error: "TEST_USER_ID not configured" }, { status: 500 });
  }

  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const sb = supabaseServer();
  const { data: playlist, error: pErr } = await sb
    .from("playlists")
    .select("id, name, description, updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  if (pErr || !playlist) {
    return NextResponse.json({ error: pErr?.message ?? "not found" }, { status: 404 });
  }

  const { data: items, error: iErr } = await sb
    .from("playlist_items")
    .select("artist_id, rank, reason, artists(name, genres)")
    .eq("playlist_id", id)
    .order("rank", { ascending: true });
  if (iErr) {
    return NextResponse.json({ error: iErr.message }, { status: 500 });
  }

  const meta = parseMeta(playlist.description);

  return NextResponse.json({
    id: playlist.id,
    name: playlist.name,
    prompt: meta.prompt ?? "",
    weights: meta.weights ?? null,
    updatedAt: playlist.updated_at,
    items: (items ?? []).map((row: any) => ({
      artist_id: row.artist_id,
      rank: row.rank,
      reason: row.reason,
      artist_name: row.artists?.name ?? "Unknown",
      genres: row.artists?.genres ?? [],
    })),
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = process.env.TEST_USER_ID;
  if (!userId) {
    return NextResponse.json({ error: "TEST_USER_ID not configured" }, { status: 500 });
  }

  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const sb = supabaseServer();
  const { error } = await sb
    .from("playlists")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

function parseMeta(description: string | null): { prompt?: string; weights?: any } {
  if (!description) return {};
  try {
    const parsed = JSON.parse(description);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore
  }
  return {};
}
