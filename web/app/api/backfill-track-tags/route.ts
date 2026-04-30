import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/backfill-track-tags
 *
 * Triggers the backend to fetch Last.fm tags for tracks and refresh
 * their embedding source. Run /api/embed-tracks afterwards so the
 * cleared embeddings are regenerated with the mood-aware source.
 *
 * Optional query params:
 *  - refresh=1: re-tag tracks that already have tags
 *  - limit=N:  cap how many tracks to process this run
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

  const url = new URL(req.url);
  const query = new URLSearchParams();
  if (url.searchParams.get("refresh")) query.set("refresh", "true");
  const limit = url.searchParams.get("limit");
  if (limit) query.set("limit", limit);
  const qs = query.toString();
  const upstream = await fetch(
    `${apiUrl}/ingest/backfill-track-tags${qs ? `?${qs}` : ""}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceRoleKey}` },
    }
  );
  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
