import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function cacheKey(prompt: string, strategy: unknown): string {
  return JSON.stringify({
    prompt: prompt.trim(),
    strategy: strategy ?? null,
  });
}

export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const body = await req.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const strategy = body.strategy ?? null;
  const results = Array.isArray(body.results) ? body.results : [];
  const sourceMix = body.source_mix && typeof body.source_mix === "object" ? body.source_mix : {};

  if (results.length < 8) {
    return NextResponse.json(
      { error: "station cache requires at least 8 tracks" },
      { status: 400 }
    );
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sb = supabaseServer();
  const { data, error } = await sb
    .from("station_cache")
    .upsert(
      {
        user_id: user.userId,
        cache_key: cacheKey(prompt, strategy),
        prompt: prompt.trim() || null,
        strategy: strategy ?? {},
        results,
        source_mix: sourceMix,
        expires_at: expiresAt,
      },
      { onConflict: "user_id,cache_key" }
    )
    .select("id,created_at,expires_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, station_id: data?.id, expires_at: data?.expires_at });
}
