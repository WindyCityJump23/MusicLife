import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";
import { createTasteSnapshot } from "@/lib/taste-snapshot";

export const dynamic = "force-dynamic";

type DiscoveryMix = {
  deep_cuts: number;
  popular: number;
  radio_hits: number;
};

type TasteStrategy = {
  genre_boosts: string[];
  genre_avoids: string[];
  discovery_mix: DiscoveryMix;
  station_distance: "closer" | "balanced" | "further";
  familiarity: "anchors" | "balanced" | "surprises";
  live_expansion: "auto" | "catalog" | "live";
  freshness: "newer" | "balanced" | "timeless";
};

const DEFAULT_STRATEGY: TasteStrategy = {
  genre_boosts: [],
  genre_avoids: [],
  discovery_mix: { deep_cuts: 38, popular: 38, radio_hits: 24 },
  station_distance: "balanced",
  familiarity: "balanced",
  live_expansion: "auto",
  freshness: "balanced",
};

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of value) {
    const text = String(item ?? "").trim().toLowerCase();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    cleaned.push(text.slice(0, 48));
    if (cleaned.length >= 12) break;
  }
  return cleaned;
}

function cleanMix(value: unknown): DiscoveryMix {
  const raw = typeof value === "object" && value !== null ? value as Partial<DiscoveryMix> : {};
  const deep = Math.max(0, Math.min(100, Number(raw.deep_cuts ?? DEFAULT_STRATEGY.discovery_mix.deep_cuts)));
  const popular = Math.max(0, Math.min(100, Number(raw.popular ?? DEFAULT_STRATEGY.discovery_mix.popular)));
  const hits = Math.max(0, Math.min(100, Number(raw.radio_hits ?? DEFAULT_STRATEGY.discovery_mix.radio_hits)));
  const total = deep + popular + hits;
  if (!Number.isFinite(total) || total <= 0) return DEFAULT_STRATEGY.discovery_mix;
  return {
    deep_cuts: Math.round((deep / total) * 100),
    popular: Math.round((popular / total) * 100),
    radio_hits: Math.max(0, 100 - Math.round((deep / total) * 100) - Math.round((popular / total) * 100)),
  };
}

function normalizeStrategy(value: unknown): TasteStrategy {
  const raw = typeof value === "object" && value !== null ? value as Partial<TasteStrategy> : {};
  const liveExpansion = raw.live_expansion === "catalog" || raw.live_expansion === "live"
    ? raw.live_expansion
    : "auto";
  const freshness = raw.freshness === "newer" || raw.freshness === "timeless"
    ? raw.freshness
    : "balanced";
  const stationDistance = raw.station_distance === "closer" || raw.station_distance === "further"
    ? raw.station_distance
    : "balanced";
  const familiarity = raw.familiarity === "anchors" || raw.familiarity === "surprises"
    ? raw.familiarity
    : "balanced";
  const avoids = cleanList(raw.genre_avoids);
  const avoidSet = new Set(avoids);
  return {
    genre_boosts: cleanList(raw.genre_boosts).filter((genre) => !avoidSet.has(genre)),
    genre_avoids: avoids,
    discovery_mix: cleanMix(raw.discovery_mix),
    station_distance: stationDistance,
    familiarity,
    live_expansion: liveExpansion,
    freshness,
  };
}

export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();
  const { data, error } = await sb
    .from("user_taste_strategy")
    .select("genre_boosts,genre_avoids,discovery_mix,station_distance,familiarity,live_expansion,freshness,updated_at")
    .eq("user_id", user.userId)
    .maybeSingle();

  if (error) {
    console.error("taste-strategy: read failed", error);
    return NextResponse.json({ strategy: DEFAULT_STRATEGY, stored: false });
  }

  return NextResponse.json({
    strategy: normalizeStrategy(data ?? DEFAULT_STRATEGY),
    stored: Boolean(data),
    updated_at: data?.updated_at ?? null,
  });
}

export async function PUT(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const body = await req.json().catch(() => ({}));
  const strategy = normalizeStrategy(body);
  const sb = supabaseServer();

  const { data, error } = await sb
    .from("user_taste_strategy")
    .upsert(
      {
        user_id: user.userId,
        genre_boosts: strategy.genre_boosts,
        genre_avoids: strategy.genre_avoids,
        discovery_mix: strategy.discovery_mix,
        station_distance: strategy.station_distance,
        familiarity: strategy.familiarity,
        live_expansion: strategy.live_expansion,
        freshness: strategy.freshness,
      },
      { onConflict: "user_id" }
    )
    .select("genre_boosts,genre_avoids,discovery_mix,station_distance,familiarity,live_expansion,freshness,updated_at")
    .single();

  if (error) {
    console.error("taste-strategy: write failed", error);
    return NextResponse.json({ error: "Failed to save taste strategy" }, { status: 500 });
  }

  await createTasteSnapshot({ sb, userId: user.userId, reason: "strategy_saved" });

  return NextResponse.json({
    ok: true,
    strategy: normalizeStrategy(data),
    updated_at: data.updated_at,
  });
}
