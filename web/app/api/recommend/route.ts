import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";

type SignalBreakdown = { affinity: number; context: number; editorial: number };
type TopMention = { source: string; excerpt: string; published_at: string };

type ArtistResult = {
  artist_id: string;
  artist_name: string;
  score: number;
  signals: SignalBreakdown;
  reasons: string[];
  genres: string[];
  mention_count: number;
  top_mention: TopMention | null;
};

type SongResult = {
  track_id: string;
  track_uri: string;
  track_name: string;
  artist_id: string;
  artist_name: string;
  album: string;
  album_art: string | null;
  duration_ms: number;
  spotify_url: string;
  score: number;
  signals: SignalBreakdown;
  reasons: string[];
  genres: string[];
  mention_count: number;
  top_mention: TopMention | null;
};

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

  // Step 1: rank artists via the taste model.
  const upstream = await fetch(`${apiUrl}/recommend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ user_id: user.userId, ...body }),
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return NextResponse.json(data, { status: upstream.status });
  }

  const artistResults: ArtistResult[] = Array.isArray(data?.results) ? data.results : [];
  if (artistResults.length === 0) {
    return NextResponse.json({ results: [] });
  }

  // Step 2: get the user's Spotify access token so we can resolve each
  // ranked artist to a specific track. Without it we fall back to artist-
  // only results so the page still works.
  const cookieHeader = req.headers.get("cookie") ?? "";
  const tokenRes = await fetch(`${req.nextUrl.origin}/api/auth/token`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });

  if (!tokenRes.ok) {
    return NextResponse.json({ results: artistResults });
  }

  const tokenData = await tokenRes.json().catch(() => ({}));
  const accessToken: string | undefined = tokenData.access_token;
  if (!accessToken) {
    return NextResponse.json({ results: artistResults });
  }

  const spotifyHeaders = { Authorization: `Bearer ${accessToken}` };

  // Step 3: for each ranked artist, fetch their top track on Spotify.
  // Process in batches of 5 to respect rate limits, mirroring the
  // pattern used by /api/playlist.
  const songs: SongResult[] = [];
  for (let i = 0; i < artistResults.length; i += 5) {
    const batch = artistResults.slice(i, i + 5);
    const resolved = await Promise.all(
      batch.map((rec) => resolveArtistToSong(rec, spotifyHeaders))
    );
    for (const s of resolved) {
      if (s) songs.push(s);
    }
    if (i + 5 < artistResults.length) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  return NextResponse.json({ results: songs });
}

async function resolveArtistToSong(
  rec: ArtistResult,
  headers: Record<string, string>
): Promise<SongResult | null> {
  try {
    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(rec.artist_name)}&type=artist&limit=1`,
      { headers }
    );
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const found = searchData.artists?.items?.[0];
    if (!found?.id) return null;

    const tracksRes = await fetch(
      `https://api.spotify.com/v1/artists/${found.id}/top-tracks?market=US`,
      { headers }
    );
    if (!tracksRes.ok) return null;

    const tracksData = await tracksRes.json();
    const top = tracksData.tracks?.[0];
    if (!top?.uri) return null;

    return {
      track_id: top.id,
      track_uri: top.uri,
      track_name: top.name,
      artist_id: rec.artist_id,
      artist_name:
        top.artists?.map((a: { name: string }) => a.name).join(", ") ?? rec.artist_name,
      album: top.album?.name ?? "",
      album_art: top.album?.images?.[0]?.url ?? null,
      duration_ms: top.duration_ms ?? 0,
      spotify_url: top.external_urls?.spotify ?? "",
      score: rec.score,
      signals: rec.signals,
      reasons: rec.reasons,
      genres: rec.genres,
      mention_count: rec.mention_count,
      top_mention: rec.top_mention,
    };
  } catch {
    return null;
  }
}
