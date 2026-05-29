import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type CheckResult = {
  name: string;
  ok: boolean;
  error?: string;
};

async function checkTable(
  name: string,
  table: string,
  columns: string
): Promise<CheckResult> {
  try {
    const { error } = await supabaseServer()
      .from(table)
      .select(columns, { head: true })
      .limit(1);
    if (error) return { name, ok: false, error: error.message };
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkMatchTracksRpc(): Promise<CheckResult> {
  try {
    const { error } = await supabaseServer().rpc("match_tracks", {
      query_embedding: null,
      match_count: 1,
      genre_tokens: null,
    });
    if (error) return { name: "match_tracks_rpc", ok: false, error: error.message };
    return { name: "match_tracks_rpc", ok: true };
  } catch (err) {
    return {
      name: "match_tracks_rpc",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET() {
  const checks = await Promise.all([
    checkTable("station_cache", "station_cache", "id,user_id,cache_key,results,expires_at"),
    checkTable(
      "station_runs",
      "station_runs",
      "id,user_id,status,fallback_level,result_count,latency_ms"
    ),
    checkTable(
      "recommendation_events",
      "recommendation_events",
      "id,user_id,event_type,dwell_ms,metadata"
    ),
    checkTable("taste_snapshots", "taste_snapshots", "id,user_id,generated_at,thesis"),
    checkTable("user_feedback_reason", "user_feedback", "id,reason"),
    checkTable(
      "taste_strategy_controls",
      "user_taste_strategy",
      "user_id,station_distance,familiarity"
    ),
    checkMatchTracksRpc(),
  ]);

  const missing = checks.filter((check) => !check.ok).map((check) => check.name);
  const ok = missing.length === 0;

  return NextResponse.json(
    {
      ok,
      checked_at: new Date().toISOString(),
      missing,
      checks,
    },
    { status: ok ? 200 : 503 }
  );
}
