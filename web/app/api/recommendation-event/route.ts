import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const ALLOWED_EVENTS = new Set([
  "impression",
  "play",
  "skip",
  "thumb_up",
  "thumb_down",
  "too_familiar",
  "too_far",
  "favorite",
  "save_playlist",
  "open_spotify",
]);

function intOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const body = await req.json().catch(() => ({}));
  const eventType = typeof body.event_type === "string" ? body.event_type : "";
  if (!ALLOWED_EVENTS.has(eventType)) {
    return NextResponse.json({ error: "invalid event_type" }, { status: 400 });
  }

  const sb = supabaseServer();
  const { error } = await sb.from("recommendation_events").insert({
    user_id: user.userId,
    station_run_id: typeof body.station_run_id === "string" ? body.station_run_id : null,
    spotify_track_id: typeof body.spotify_track_id === "string" ? body.spotify_track_id : null,
    track_id: intOrNull(body.track_id),
    artist_id: intOrNull(body.artist_id),
    event_type: eventType,
    position: intOrNull(body.position),
    prompt: typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null,
    source: typeof body.source === "string" && body.source.trim() ? body.source.trim() : "radio",
    dwell_ms: intOrNull(body.dwell_ms),
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
