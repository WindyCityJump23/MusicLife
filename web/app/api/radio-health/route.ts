import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type StationRun = {
  status: string | null;
  fallback_level: string | null;
  result_count: number | null;
  latency_ms: number | null;
  error_class: string | null;
  created_at: string | null;
  source_mix: {
    catalogCount?: number;
    liveCount?: number;
    laneCounts?: Record<string, number>;
  } | null;
};

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const sb = supabaseServer();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("station_runs")
    .select("status,fallback_level,result_count,latency_ms,error_class,created_at,source_mix")
    .eq("user_id", user.userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const runs = (data ?? []) as StationRun[];
  const attempts = runs.length;
  const successful = runs.filter((run) => run.status === "success" || run.status === "partial");
  const fallbackRuns = runs.filter((run) =>
    run.fallback_level === "cache" || run.fallback_level === "starter"
  );
  const timeoutRuns = runs.filter((run) =>
    String(run.error_class ?? "").toLowerCase().includes("timeout")
  );
  const latencies = runs.flatMap((run) =>
    typeof run.latency_ms === "number" && Number.isFinite(run.latency_ms) && run.latency_ms >= 0
      ? [run.latency_ms]
      : []
  );
  const counts = runs.flatMap((run) =>
    typeof run.result_count === "number" && Number.isFinite(run.result_count) && run.result_count >= 0
      ? [run.result_count]
      : []
  );

  // Live-vs-catalog source mix. When most picks come from live Spotify search
  // rather than the scored catalog, the lane quotas and novelty model are
  // largely bypassed at runtime — this ratio makes that visible so we can alert
  // on it (see docs/PRODUCTION_AUDIT.md, "lane-balance gap").
  let catalogTotal = 0;
  let liveTotal = 0;
  // Lane health: aggregate per-lane track totals and the share of runs that
  // produced ZERO radio hits — the lane that silently emptied when Spotify
  // stopped returning popularity scores.
  const laneTotals: Record<string, number> = {};
  let runsWithLaneCounts = 0;
  let runsWithZeroRadioHits = 0;
  for (const run of runs) {
    const mix = run.source_mix ?? {};
    catalogTotal += Number(mix.catalogCount ?? 0) || 0;
    liveTotal += Number(mix.liveCount ?? 0) || 0;
    const laneCounts = mix.laneCounts;
    if (laneCounts && typeof laneCounts === "object") {
      runsWithLaneCounts += 1;
      for (const [lane, count] of Object.entries(laneCounts)) {
        laneTotals[lane] = (laneTotals[lane] ?? 0) + (Number(count) || 0);
      }
      if (!Number(laneCounts.radio_hits)) {
        runsWithZeroRadioHits += 1;
      }
    }
  }
  const mixTotal = catalogTotal + liveTotal;
  const liveSourceRatio = mixTotal > 0 ? liveTotal / mixTotal : null;
  const zeroRadioHitsRate =
    runsWithLaneCounts > 0 ? runsWithZeroRadioHits / runsWithLaneCounts : null;

  return NextResponse.json({
    window: "24h",
    attempts,
    last_successful_recommendation_latency_ms:
      successful.find((run) => typeof run.latency_ms === "number")?.latency_ms ?? null,
    recent_timeout_rate: attempts > 0 ? timeoutRuns.length / attempts : 0,
    average_result_count: average(counts),
    average_latency_ms: average(latencies),
    cache_hit_rate: attempts > 0 ? fallbackRuns.length / attempts : 0,
    // Share of recommended tracks sourced from live Spotify search rather than
    // the scored catalog. High values indicate the designed lane mix is being
    // bypassed; alert when this stays above ~0.6 across attempts.
    live_source_ratio: liveSourceRatio,
    catalog_track_total: catalogTotal,
    live_track_total: liveTotal,
    // Lane distribution across recent runs + share of runs with zero radio
    // hits. Alert when zero_radio_hits_rate stays near 1.0 — it means the
    // recognizability signal has gone dark again.
    lane_totals: laneTotals,
    zero_radio_hits_rate: zeroRadioHitsRate,
    recent_error_classes: runs
      .map((run) => run.error_class)
      .filter((errorClass): errorClass is string => Boolean(errorClass))
      .slice(0, 10),
  });
}
