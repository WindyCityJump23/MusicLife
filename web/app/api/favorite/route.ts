import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

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

    // Look up the internal track_id if we have it
    const { data: trackRow } = await sb
      .from("tracks")
      .select("id")
      .eq("spotify_track_id", spotifyTrackId)
      .maybeSingle();

    await sb.from("user_favorites").upsert(
      {
        user_id: user.userId,
        track_id: trackRow?.id ?? null,
        spotify_track_id: spotifyTrackId,
        track_name: trackName ?? null,
        artist_name: artistName ?? null,
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
