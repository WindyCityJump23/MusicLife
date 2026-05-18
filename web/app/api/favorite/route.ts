import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms?: number;
  explicit?: boolean;
  popularity?: number;
  album?: {
    name?: string;
    release_date?: string;
    release_date_precision?: string;
  };
  artists?: Array<{
    id?: string;
    name?: string;
  }>;
};

type ResolvedFavoriteTrack = {
  trackId: number | null;
  trackName: string | undefined;
  artistName: string | undefined;
};

function normalizeSpotifyReleaseDate(track: SpotifyTrack): string | null {
  const releaseDate = track.album?.release_date;
  if (!releaseDate) return null;
  if (/^\d{4}$/.test(releaseDate)) return `${releaseDate}-01-01`;
  if (/^\d{4}-\d{2}$/.test(releaseDate)) return `${releaseDate}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return releaseDate;
  return null;
}

async function fetchSpotifyTrack(
  accessToken: string,
  spotifyTrackId: string
): Promise<SpotifyTrack | null> {
  const res = await fetch(`https://api.spotify.com/v1/tracks/${spotifyTrackId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as SpotifyTrack | null;
}

async function resolveTrackForFavorite({
  sb,
  spotifyTrackId,
  accessToken,
  fallbackTrackName,
  fallbackArtistName,
}: {
  sb: SupabaseClient;
  spotifyTrackId: string;
  accessToken: string;
  fallbackTrackName?: string;
  fallbackArtistName?: string;
}): Promise<ResolvedFavoriteTrack> {
  const { data: existingTrack } = await sb
    .from("tracks")
    .select("id,name,artist_id")
    .eq("spotify_track_id", spotifyTrackId)
    .maybeSingle();

  if (existingTrack?.id) {
    let resolvedArtistName = fallbackArtistName;
    if (!resolvedArtistName && existingTrack.artist_id) {
      const { data: artistRow } = await sb
        .from("artists")
        .select("name")
        .eq("id", existingTrack.artist_id)
        .maybeSingle();
      resolvedArtistName = artistRow?.name ?? undefined;
    }
    return {
      trackId: Number(existingTrack.id),
      trackName: existingTrack.name ?? fallbackTrackName,
      artistName: resolvedArtistName,
    };
  }

  const spotifyTrack = await fetchSpotifyTrack(accessToken, spotifyTrackId);
  if (!spotifyTrack?.id) {
    return {
      trackId: null,
      trackName: fallbackTrackName,
      artistName: fallbackArtistName,
    };
  }

  const primaryArtist = (spotifyTrack.artists ?? []).find((artist) => artist.id) ?? spotifyTrack.artists?.[0];
  let artistId: number | null = null;
  if (primaryArtist?.id) {
    const { data: artistRow } = await sb
      .from("artists")
      .upsert(
        {
          spotify_artist_id: primaryArtist.id,
          name: primaryArtist.name ?? fallbackArtistName ?? "Unknown Artist",
        },
        { onConflict: "spotify_artist_id" }
      )
      .select("id")
      .maybeSingle();
    artistId = artistRow?.id ? Number(artistRow.id) : null;
  } else if (primaryArtist?.name || fallbackArtistName) {
    const { data: artistRow } = await sb
      .from("artists")
      .select("id")
      .eq("name", primaryArtist?.name ?? fallbackArtistName)
      .maybeSingle();
    artistId = artistRow?.id ? Number(artistRow.id) : null;
  }

  const { data: trackRow } = await sb
    .from("tracks")
    .upsert(
      {
        spotify_track_id: spotifyTrack.id,
        artist_id: artistId,
        name: spotifyTrack.name,
        album_name: spotifyTrack.album?.name ?? null,
        duration_ms: spotifyTrack.duration_ms ?? null,
        explicit: spotifyTrack.explicit ?? null,
        popularity: spotifyTrack.popularity ?? null,
        release_date: normalizeSpotifyReleaseDate(spotifyTrack),
      },
      { onConflict: "spotify_track_id" }
    )
    .select("id")
    .maybeSingle();

  return {
    trackId: trackRow?.id ? Number(trackRow.id) : null,
    trackName: spotifyTrack.name,
    artistName: primaryArtist?.name ?? fallbackArtistName,
  };
}

async function insertUserTrackForFavorite(
  sb: SupabaseClient,
  userId: string,
  trackId: number | null
) {
  if (!trackId) return;

  const { data: existing } = await sb
    .from("user_tracks")
    .select("added_at")
    .eq("user_id", userId)
    .eq("track_id", trackId)
    .maybeSingle();

  if (existing) {
    if (!existing.added_at) {
      await sb
        .from("user_tracks")
        .update({ added_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("track_id", trackId);
    }
    return;
  }

  await sb.from("user_tracks").insert({
    user_id: userId,
    track_id: trackId,
    added_at: new Date().toISOString(),
    play_count: 0,
  });
}

/**
 * POST /api/favorite
 *
 * Saves a track to the user's Spotify Liked Songs AND records the
 * favorite in our DB for recommendation learning.
 *
 * Body: {
 *   spotify_track_id: string,
 *   track_name?: string,
 *   artist_name?: string,
 *   score?: number,        — recommendation score at time of favorite
 *   source?: string,       — where the favorite happened (discover, playlists, etc.)
 * }
 *
 * DELETE /api/favorite
 *
 * Removes a track from Spotify Liked Songs and our DB.
 *
 * Body: { spotify_track_id: string }
 */
export async function POST(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  let spotifyTrackId: string;
  let trackName: string | undefined;
  let artistName: string | undefined;
  let score: number | undefined;
  let source = "discover";

  try {
    const body = await request.json();
    spotifyTrackId = body.spotify_track_id;
    trackName = body.track_name;
    artistName = body.artist_name;
    score = body.score;
    if (body.source) source = body.source;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!spotifyTrackId || typeof spotifyTrackId !== "string") {
    return NextResponse.json(
      { error: "spotify_track_id is required" },
      { status: 400 }
    );
  }

  // ── Get Spotify access token ───────────────────────────────
  const cookieHeader = request.headers.get("cookie") ?? "";
  const tokenRes = await fetch(`${request.nextUrl.origin}/api/auth/token`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });

  if (!tokenRes.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData.access_token;
  if (!accessToken) {
    return NextResponse.json({ error: "No access token" }, { status: 401 });
  }

  // ── Save to Spotify Liked Songs ────────────────────────────
  const spotifyRes = await fetch(
    `https://api.spotify.com/v1/me/tracks`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: [spotifyTrackId] }),
    }
  );

  if (!spotifyRes.ok && spotifyRes.status !== 200) {
    const err = await spotifyRes.json().catch(() => ({}));
    const msg = err?.error?.message ?? "Failed to save to Spotify";

    if (spotifyRes.status === 403) {
      return NextResponse.json(
        {
          error:
            "Missing permissions. Please sign out and sign back in to grant library access.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ error: msg }, { status: spotifyRes.status });
  }

  // ── Record in our DB for learning ──────────────────────────
  try {
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });

    const resolvedTrack = await resolveTrackForFavorite({
      sb,
      spotifyTrackId,
      accessToken,
      fallbackTrackName: trackName,
      fallbackArtistName: artistName,
    });
    await insertUserTrackForFavorite(sb, user.userId, resolvedTrack.trackId);

    await sb.from("user_favorites").upsert(
      {
        user_id: user.userId,
        track_id: resolvedTrack.trackId,
        spotify_track_id: spotifyTrackId,
        track_name: resolvedTrack.trackName ?? trackName ?? null,
        artist_name: resolvedTrack.artistName ?? artistName ?? null,
        score: score ?? null,
        source,
      },
      { onConflict: "user_id,spotify_track_id" }
    );
  } catch (err) {
    // Don't fail the request if DB write fails — Spotify save already succeeded
    console.error("favorite: DB write failed", err);
  }

  return NextResponse.json({ ok: true, favorited: true });
}

export async function DELETE(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  let spotifyTrackId: string;

  try {
    const body = await request.json();
    spotifyTrackId = body.spotify_track_id;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!spotifyTrackId || typeof spotifyTrackId !== "string") {
    return NextResponse.json(
      { error: "spotify_track_id is required" },
      { status: 400 }
    );
  }

  // ── Get Spotify access token ───────────────────────────────
  const cookieHeader = request.headers.get("cookie") ?? "";
  const tokenRes = await fetch(`${request.nextUrl.origin}/api/auth/token`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });

  if (!tokenRes.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData.access_token;

  // ── Remove from Spotify Liked Songs ────────────────────────
  await fetch(`https://api.spotify.com/v1/me/tracks`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ids: [spotifyTrackId] }),
  });

  // ── Remove from our DB ─────────────────────────────────────
  try {
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });

    await sb
      .from("user_favorites")
      .delete()
      .eq("user_id", user.userId)
      .eq("spotify_track_id", spotifyTrackId);
  } catch (err) {
    console.error("unfavorite: DB delete failed", err);
  }

  return NextResponse.json({ ok: true, favorited: false });
}
