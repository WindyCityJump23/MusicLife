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
    .select("status,fallback_level,result_count,latency_ms,error_class,created_at")
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

  return NextResponse.json({
    window: "24h",
    attempts,
    last_successful_recommendation_latency_ms:
      successful.find((run) => typeof run.latency_ms === "number")?.latency_ms ?? null,
    recent_timeout_rate: attempts > 0 ? timeoutRuns.length / attempts : 0,
    average_result_count: average(counts),
    average_latency_ms: average(latencies),
    cache_hit_rate: attempts > 0 ? fallbackRuns.length / attempts : 0,
    recent_error_classes: runs
      .map((run) => run.error_class)
      .filter((errorClass): errorClass is string => Boolean(errorClass))
      .slice(0, 10),
  });
}
