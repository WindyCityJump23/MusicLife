import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/radio-health/calibration
 *
 * Buckets recommendation outcomes by the score shown to the user, answering
 * "does an 86% match actually get favorited/played more than a 70% match?".
 * Impressions/plays/skips read the score recorded in event metadata;
 * favorites read the score stored on user_favorites at heart time.
 *
 * This is the observability half of calibration — once enough events have a
 * recorded score, these rates are the ground truth for re-weighting the
 * affinity/context/editorial blend.
 */

const WINDOW_DAYS = 30;
const EVENT_LIMIT = 5000;
const BUCKET_SIZE = 0.1;

type BucketRow = {
  bucket: string;
  impressions: number;
  plays: number;
  skips: number;
  favorites: number;
  thumbs_up: number;
  thumbs_down: number;
};

function bucketKey(score: number): string {
  const clamped = Math.max(0, Math.min(0.999, score));
  const low = Math.floor(clamped / BUCKET_SIZE) * BUCKET_SIZE;
  return `${low.toFixed(1)}–${(low + BUCKET_SIZE).toFixed(1)}`;
}

export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [eventsRes, favoritesRes] = await Promise.all([
    sb
      .from("recommendation_events")
      .select("event_type, metadata, created_at")
      .eq("user_id", user.userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(EVENT_LIMIT),
    sb
      .from("user_favorites")
      .select("score, created_at")
      .eq("user_id", user.userId)
      .gte("created_at", since)
      .limit(EVENT_LIMIT),
  ]);

  if (eventsRes.error) {
    return NextResponse.json({ error: eventsRes.error.message }, { status: 500 });
  }

  const buckets = new Map<string, BucketRow>();
  function bucketFor(score: number): BucketRow {
    const key = bucketKey(score);
    let row = buckets.get(key);
    if (!row) {
      row = { bucket: key, impressions: 0, plays: 0, skips: 0, favorites: 0, thumbs_up: 0, thumbs_down: 0 };
      buckets.set(key, row);
    }
    return row;
  }

  let eventsWithScore = 0;
  let eventsWithoutScore = 0;
  for (const event of eventsRes.data ?? []) {
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    const score = Number(meta.score);
    if (!Number.isFinite(score)) {
      eventsWithoutScore += 1;
      continue;
    }
    eventsWithScore += 1;
    const row = bucketFor(score);
    switch (event.event_type) {
      case "impression": row.impressions += 1; break;
      case "play": row.plays += 1; break;
      case "skip": row.skips += 1; break;
      case "thumb_up": row.thumbs_up += 1; break;
      case "thumb_down": row.thumbs_down += 1; break;
    }
  }

  for (const fav of favoritesRes.data ?? []) {
    const score = Number(fav.score);
    if (!Number.isFinite(score)) continue;
    bucketFor(score).favorites += 1;
  }

  const rows = [...buckets.values()]
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map((row) => ({
      ...row,
      play_rate: row.impressions > 0 ? Number((row.plays / row.impressions).toFixed(3)) : null,
      skip_rate: row.impressions > 0 ? Number((row.skips / row.impressions).toFixed(3)) : null,
      favorite_rate:
        row.impressions > 0 ? Number((row.favorites / row.impressions).toFixed(3)) : null,
    }));

  return NextResponse.json({
    window_days: WINDOW_DAYS,
    events_with_score: eventsWithScore,
    // Events logged before score capture shipped have no score; this shrinks
    // toward zero as new impressions accumulate.
    events_without_score: eventsWithoutScore,
    buckets: rows,
  });
}
