import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 55;
const UPSTREAM_TIMEOUT_MS = 18_000;

function statusForFallback(fallbackLevel: string | undefined, resultCount: number): string {
  if (fallbackLevel === "empty" || resultCount === 0) return "empty";
  if (fallbackLevel === "partial") return "partial";
  return "success";
}

async function recordStationRun({
  userId,
  prompt,
  strategy,
  status,
  fallbackLevel,
  resultCount,
  latencyMs,
  sourceMix,
  errorClass,
}: {
  userId: string;
  prompt: string | null;
  strategy: unknown;
  status: string;
  fallbackLevel: string;
  resultCount: number;
  latencyMs: number;
  sourceMix?: unknown;
  errorClass?: string | null;
}) {
  try {
    await supabaseServer().from("station_runs").insert({
      user_id: userId,
      prompt,
      strategy: strategy && typeof strategy === "object" ? strategy : {},
      status,
      fallback_level: fallbackLevel,
      result_count: resultCount,
      latency_ms: latencyMs,
      source_mix: sourceMix && typeof sourceMix === "object" ? sourceMix : {},
      error_class: errorClass ?? null,
    });
  } catch (err) {
    console.warn("recommend-songs: station run telemetry failed", err);
  }
}

export async function GET() {
  return NextResponse.json(
    { error: "Use POST /api/recommend-songs for discovery." },
    { status: 405 }
  );
}

/**
 * POST /api/recommend-songs
 *
 * Proxies to the Render backend's /recommend/songs endpoint which
 * returns song-level recommendations from the DB (with familiarity
 * penalties, audio features, genre diversity re-ranking).
 */
export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  let tasteStrategy = body.taste_strategy ?? null;

  if (!prompt && tasteStrategy === null && body.use_taste_strategy !== false) {
    try {
      const { data } = await supabaseServer()
        .from("user_taste_strategy")
        .select("genre_boosts,genre_avoids,discovery_mix,station_distance,familiarity,live_expansion,freshness")
        .eq("user_id", user.userId)
        .maybeSingle();
      tasteStrategy = data ?? null;
    } catch (err) {
      console.warn("recommend-songs: taste strategy unavailable", err);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  const startedAt = Date.now();
  try {
    upstream = await fetch(`${apiUrl}/recommend/songs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        user_id: user.userId,
        prompt: prompt || null,
        weights: body.weights ?? { affinity: 0.75, context: 0.15, editorial: 0.1 },
        limit: body.limit ?? 30,
        exclude_library: body.exclude_library ?? false,
        exclude_saved_tracks: body.exclude_saved_tracks ?? true,
        discover_run_id: body.discover_run_id ?? null,
        exclude_previously_shown: body.exclude_previously_shown ?? true,
        history_window_runs: body.history_window_runs ?? 15,
        max_allowed_overlap: body.max_allowed_overlap ?? 0,
        novelty_mode: body.novelty_mode ?? "strict",
        taste_strategy: prompt ? null : tasteStrategy,
      }),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    console.warn(
      timedOut
        ? "recommend-songs: upstream catalog search timed out; client should use Spotify fallback"
        : "recommend-songs: upstream catalog search failed; client should use Spotify fallback",
      err
    );
    await recordStationRun({
      userId: user.userId,
      prompt: prompt || null,
      strategy: tasteStrategy,
      status: "empty",
      fallbackLevel: "empty",
      resultCount: 0,
      latencyMs: Date.now() - startedAt,
      sourceMix: {},
      errorClass: timedOut ? "upstream_timeout" : "upstream_failure",
    });
    return NextResponse.json({
      results: [],
      fallback_level: "empty",
      timing_ms: Date.now() - startedAt,
      source_mix: {},
      warnings: [
        timedOut
          ? "catalog_search_timed_out"
          : "catalog_search_failed",
      ],
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = await upstream.json().catch(() => ({}));
  const resultCount = Array.isArray(data.results) ? data.results.length : 0;
  const fallbackLevel = data.fallback_level ?? (resultCount > 0 ? "fresh" : "empty");
  await recordStationRun({
    userId: user.userId,
    prompt: prompt || null,
    strategy: tasteStrategy,
    status: upstream.ok ? statusForFallback(fallbackLevel, resultCount) : "error",
    fallbackLevel,
    resultCount,
    latencyMs: typeof data.timing_ms === "number" ? data.timing_ms : Date.now() - startedAt,
    sourceMix: data.source_mix,
    errorClass: upstream.ok ? null : `upstream_${upstream.status}`,
  });
  console.info("recommend-songs: upstream response", {
    status: upstream.status,
    prompt: prompt || null,
    result_count: resultCount,
    fallback_level: fallbackLevel,
    query_search_phrase: data.query_intent?.search_phrase ?? null,
  });
  if (!upstream.ok && upstream.status >= 500) {
    return NextResponse.json({
      results: [],
      fallback_level: "empty",
      timing_ms: Date.now() - startedAt,
      source_mix: {},
      warnings: [`upstream_${upstream.status}`],
      error: data.error ?? data.detail ?? "Catalog search failed",
    });
  }
  return NextResponse.json(data, { status: upstream.status });
}
