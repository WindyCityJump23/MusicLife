import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type ArtistResult = { artist_id: string; spotify_artist_id?: string | null };

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

  const upstream = await fetch(`${apiUrl}/recommend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ user_id: user.userId, ...body }),
  });

  const data = await upstream.json().catch(() => ({}));

  // Enrich each result with the artist's cached Spotify ID so the Discover
  // client can skip the per-artist /v1/search call. The Python ranking
  // service already has spotify_artist_id in its query path; we just attach
  // it here to avoid a backend redeploy.
  if (upstream.ok && Array.isArray(data?.results) && data.results.length > 0) {
    const dbIds = data.results
      .map((r: ArtistResult) => Number(r.artist_id))
      .filter((n: number) => Number.isFinite(n));
    if (dbIds.length > 0) {
      try {
        const sb = supabaseServer();
        const { data: rows } = await sb
          .from("artists")
          .select("id, spotify_artist_id")
          .in("id", dbIds);
        const idMap = new Map<string, string>();
        for (const row of rows ?? []) {
          if (row.spotify_artist_id) idMap.set(String(row.id), row.spotify_artist_id);
        }
        data.results = data.results.map((r: ArtistResult) => ({
          ...r,
          spotify_artist_id: idMap.get(r.artist_id) ?? null,
        }));
      } catch {
        // Enrichment is a perf optimization; fall back to client-side search.
      }
    }
  }

  return NextResponse.json(data, { status: upstream.status });
}
