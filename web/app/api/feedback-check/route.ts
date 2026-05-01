import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * GET /api/feedback-check?ids=id1,id2,id3
 *
 * Returns the feedback value for each given Spotify track ID for the current user.
 * Response: { feedback: { [spotify_track_id: string]: 1 | -1 } }
 * Only tracks with recorded feedback appear in the map (neutral tracks are omitted).
 */
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  if (isErrorResponse(user)) return user;

  const { searchParams } = new URL(request.url);
  const idsParam = searchParams.get("ids");

  if (!idsParam) {
    return NextResponse.json({ feedback: {} });
  }

  const ids = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return NextResponse.json({ feedback: {} });
  }

  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );

    const { data } = await sb
      .from("user_feedback")
      .select("spotify_track_id,feedback")
      .eq("user_id", user.userId)
      .in("spotify_track_id", ids);

    const feedbackMap: Record<string, number> = {};
    for (const row of data ?? []) {
      feedbackMap[row.spotify_track_id] = row.feedback;
    }

    return NextResponse.json({ feedback: feedbackMap });
  } catch {
    return NextResponse.json(
      { error: "Failed to check feedback" },
      { status: 500 }
    );
  }
}
