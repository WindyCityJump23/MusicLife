import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";
import { isExplicitUtilityTrackRequest, isUtilityTrack } from "@/lib/track-quality";

export const dynamic = "force-dynamic";

function cacheKey(prompt: string, strategy: unknown): string {
  return JSON.stringify({
    prompt: prompt.trim(),
    strategy: strategy ?? null,
  });
}

async function recordStationRun({
  userId,
  prompt,
  strategy,
  resultCount,
  sourceMix,
}: {
  userId: string;
  prompt: string | null;
  strategy: unknown;
  resultCount: number;
  sourceMix: unknown;
}): Promise<string | null> {
  try {
    const { data, error } = await supabaseServer()
      .from("station_runs")
      .insert({
        user_id: userId,
        prompt,
        strategy: strategy && typeof strategy === "object" ? strategy : {},
        status: "success",
        fallback_level: "fresh",
        result_count: resultCount,
        latency_ms: null,
        source_mix: sourceMix && typeof sourceMix === "object" ? sourceMix : {},
        error_class: null,
      })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return typeof data?.id === "string" ? data.id : null;
  } catch (err) {
    console.warn("station-cache: station run telemetry failed", err);
    return null;
  }
}

export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const body = await req.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const strategy = body.strategy ?? null;
  const rawResults: Array<{ track_name?: string | null; album_name?: string | null }> =
    Array.isArray(body.results) ? body.results : [];
  const results = rawResults.filter((track) =>
    isExplicitUtilityTrackRequest(prompt) ||
    !isUtilityTrack({
      name: track?.track_name,
      album_name: track?.album_name,
    })
  );
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

  const runId = await recordStationRun({
    userId: user.userId,
    prompt: prompt.trim() || null,
    strategy,
    resultCount: results.length,
    sourceMix,
  });

  return NextResponse.json({
    ok: true,
    station_id: data?.id,
    run_id: runId,
    expires_at: data?.expires_at,
  });
}
