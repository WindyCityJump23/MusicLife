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
  };
  artists?: Array<{
    id?: string;
    name?: string;
  }>;
};

type ResolvedFeedbackTrack = {
  trackId: number | null;
  artistId: number | null;
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

async function getSpotifyAccessToken(request: NextRequest): Promise<string | null> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const tokenRes = await fetch(`${request.nextUrl.origin}/api/auth/token`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });
  if (!tokenRes.ok) return null;
  const tokenData = await tokenRes.json().catch(() => ({}));
  return typeof tokenData.access_token === "string" ? tokenData.access_token : null;
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

async function resolveTrackForFeedback({
  sb,
  spotifyTrackId,
  accessToken,
  fallbackTrackName,
  fallbackArtistName,
}: {
  sb: SupabaseClient;
  spotifyTrackId: string;
  accessToken: string | null;
  fallbackTrackName?: string;
  fallbackArtistName?: string;
}): Promise<ResolvedFeedbackTrack> {
  const { data: existingTrack } = await sb
    .from("tracks")
    .select("id,name,artist_id,artists(name)")
    .eq("spotify_track_id", spotifyTrackId)
    .maybeSingle();

  if (existingTrack?.id) {
    const artist = Array.isArray(existingTrack.artists)
      ? existingTrack.artists[0]
      : existingTrack.artists;
    return {
      trackId: Number(existingTrack.id),
      artistId: existingTrack.artist_id ? Number(existingTrack.artist_id) : null,
      trackName: existingTrack.name ?? fallbackTrackName,
      artistName: artist?.name ?? fallbackArtistName,
    };
  }

  if (!accessToken) {
    return {
      trackId: null,
      artistId: null,
      trackName: fallbackTrackName,
      artistName: fallbackArtistName,
    };
  }

  const spotifyTrack = await fetchSpotifyTrack(accessToken, spotifyTrackId);
  if (!spotifyTrack?.id) {
    return {
      trackId: null,
      artistId: null,
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
    artistId,
    trackName: spotifyTrack.name,
    artistName: primaryArtist?.name ?? fallbackArtistName,
  };
}

/**
 * POST /api/feedback
 *
 * Records explicit thumbs-up (1) or thumbs-down (-1) feedback for a track.
 * Feeds back into the recommendation engine to improve future results. A
 * thumbs-down means the recommendation was wrong for this user's taste, so we
 * resolve live Spotify tracks into catalog rows whenever possible and attach
 * the feedback to both track and artist.
 *
 * Body: {
 *   spotify_track_id: string,
 *   feedback: 1 | -1,
 *   track_name?: string,
 *   artist_name?: string,
 *   score?: number,
 *   prompt?: string,
 *   source?: string,
 * }
 *
 * DELETE /api/feedback
 *
 * Removes feedback for a track (returns to neutral state).
 *
 * Body: { spotify_track_id: string }
 */
export async function POST(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  let spotifyTrackId: string;
  let feedback: number;
  let trackName: string | undefined;
  let artistName: string | undefined;
  let score: number | undefined;
  let prompt: string | undefined;
  let source = "discover";

  try {
    const body = await request.json();
    spotifyTrackId = body.spotify_track_id;
    feedback = body.feedback;
    trackName = body.track_name;
    artistName = body.artist_name;
    score = body.score;
    prompt = body.prompt;
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

  if (feedback !== 1 && feedback !== -1) {
    return NextResponse.json(
      { error: "feedback must be 1 or -1" },
      { status: 400 }
    );
  }

  try {
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const accessToken = await getSpotifyAccessToken(request);
    const resolvedTrack = await resolveTrackForFeedback({
      sb,
      spotifyTrackId,
      accessToken,
      fallbackTrackName: trackName,
      fallbackArtistName: artistName,
    });

    await sb.from("user_feedback").upsert(
      {
        user_id: user.userId,
        track_id: resolvedTrack.trackId,
        artist_id: resolvedTrack.artistId,
        spotify_track_id: spotifyTrackId,
        feedback,
        track_name: resolvedTrack.trackName ?? trackName ?? null,
        artist_name: resolvedTrack.artistName ?? artistName ?? null,
        score: score ?? null,
        prompt: prompt ?? null,
        source,
      },
      { onConflict: "user_id,spotify_track_id" }
    );
  } catch (err) {
    console.error("feedback: DB write failed", err);
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, feedback });
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

  try {
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });

    await sb
      .from("user_feedback")
      .delete()
      .eq("user_id", user.userId)
      .eq("spotify_track_id", spotifyTrackId);
  } catch (err) {
    console.error("feedback: DB delete failed", err);
  }

  return NextResponse.json({ ok: true, feedback: null });
}
