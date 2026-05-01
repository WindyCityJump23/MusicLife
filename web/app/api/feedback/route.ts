import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * POST /api/feedback
 *
 * Records explicit thumbs-up (1) or thumbs-down (-1) feedback for a track.
 * Feeds back into the recommendation engine to improve future results.
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

    // Look up internal track_id and artist_id if we have them
    const { data: trackRow } = await sb
      .from("tracks")
      .select("id,artist_id")
      .eq("spotify_track_id", spotifyTrackId)
      .maybeSingle();

    await sb.from("user_feedback").upsert(
      {
        user_id: user.userId,
        track_id: trackRow?.id ?? null,
        artist_id: trackRow?.artist_id ?? null,
        spotify_track_id: spotifyTrackId,
        feedback,
        track_name: trackName ?? null,
        artist_name: artistName ?? null,
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
