import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type SaveItem = {
  artist_id: number;
  rank: number;
  reason: string | null;
};

export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();
  const { data, error } = await sb
    .from("playlists")
    .select("id, name, description, updated_at")
    .eq("user_id", user.userId)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const views = (data ?? []).map((row: any) => {
    const meta = parseMeta(row.description);
    return {
      id: row.id,
      name: row.name,
      prompt: meta.prompt ?? "",
      updatedAt: row.updated_at,
    };
  });

  return NextResponse.json({ views });
}

export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.name !== "string" || !Array.isArray(body.items)) {
    return NextResponse.json({ error: "name + items required" }, { status: 400 });
  }

  const meta = {
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    weights: body.weights && typeof body.weights === "object" ? body.weights : null,
  };

  const sb = supabaseServer();
  const { data: playlist, error: pErr } = await sb
    .from("playlists")
    .insert({
      user_id: user.userId,
      name: body.name.trim().slice(0, 120),
      description: JSON.stringify(meta),
      visibility: "private",
    })
    .select("id")
    .single();

  if (pErr || !playlist) {
    return NextResponse.json({ error: pErr?.message ?? "insert failed" }, { status: 500 });
  }

  const items = (body.items as SaveItem[])
    .filter((it) => Number.isFinite(it.artist_id))
    .map((it) => ({
      playlist_id: playlist.id,
      artist_id: Number(it.artist_id),
      rank: Number(it.rank) || null,
      reason: typeof it.reason === "string" ? it.reason.slice(0, 500) : null,
    }));

  if (items.length > 0) {
    const { error: iErr } = await sb.from("playlist_items").insert(items);
    if (iErr) {
      return NextResponse.json({ error: iErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ id: playlist.id }, { status: 201 });
}

function parseMeta(description: string | null): { prompt?: string; weights?: any } {
  if (!description) return {};
  try {
    const parsed = JSON.parse(description);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // older rows may not be JSON
  }
  return {};
}
