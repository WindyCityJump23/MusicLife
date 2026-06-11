import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSessionUser } from "@/lib/session";
import { getClientCredentialsToken } from "@/lib/spotify-client-credentials";
import { createTasteSnapshot } from "@/lib/taste-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Constants ──────────────────────────────────────────────────
const MAX_TRACKS = 500;
const PAGE_SIZE = 100;

// Matches Spotify playlist URLs and URIs:
//   https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc
//   spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
//   37i9dQZF1DXcBWIGoYBM5M  (bare ID)
const PLAYLIST_ID_RE =
  /(?:open\.spotify\.com\/playlist\/|spotify:playlist:)([a-zA-Z0-9]+)/;
const BARE_ID_RE = /^[a-zA-Z0-9]{22}$/;

function extractPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(PLAYLIST_ID_RE);
  if (match) return match[1];
  if (BARE_ID_RE.test(trimmed)) return trimmed;
  return null;
}

function cookieOpts(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  };
}

// ── Spotify playlist types ─────────────────────────────────────
type SpotifyTrackObject = {
  id?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  popularity?: number | null;
  type?: string;
  album?: {
    name?: string;
    release_date?: string;
  };
  artists?: Array<{
    id?: string;
    name?: string;
  }>;
};

type SpotifyPlaylistTrackItem = {
  added_at?: string;
  track?: SpotifyTrackObject;
  // Spotify's newer playlist responses nest the track under `item` instead of
  // `track` (and `track` becomes a boolean discriminator on the item itself).
  item?: SpotifyTrackObject;
};

/**
 * Normalize a playlist entry to the legacy `{added_at, track}` shape.
 *
 * Mid-2026 Spotify changed the playlist APIs out from under us: the classic
 * `/playlists/{id}/tracks` endpoint now returns 403, the `tracks` object is
 * gone from playlist metadata, and the `/items` endpoint nests the track
 * under `item`. Normalizing here keeps every downstream mapper unchanged and
 * tolerates both shapes in case Spotify serves different ones per app tier.
 */
function normalizeEntry(entry: SpotifyPlaylistTrackItem): SpotifyPlaylistTrackItem {
  const track =
    entry.track && typeof entry.track === "object"
      ? entry.track
      : entry.item && typeof entry.item === "object"
      ? entry.item
      : undefined;
  // Podcast episodes can live in playlists; only music tracks are importable.
  if (track?.type === "episode") {
    return { added_at: entry.added_at, track: undefined };
  }
  return { added_at: entry.added_at, track };
}

// ── POST /api/import-playlist ──────────────────────────────────
export async function POST(req: NextRequest) {
  const secure = process.env.NODE_ENV === "production";

  // ── Parse body ────────────────────────────────────────────────
  let rawUrl: string;
  try {
    const body = await req.json();
    rawUrl = body.url;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  if (!rawUrl || typeof rawUrl !== "string") {
    return NextResponse.json(
      { error: "url is required" },
      { status: 400 }
    );
  }

  const playlistId = extractPlaylistId(rawUrl);
  if (!playlistId) {
    return NextResponse.json(
      {
        error: "invalid_url",
        message:
          "Could not parse a Spotify playlist ID from that URL. Paste a link like https://open.spotify.com/playlist/...",
      },
      { status: 400 }
    );
  }

  // ── Get client credentials token ──────────────────────────────
  let ccToken: string;
  try {
    ccToken = await getClientCredentialsToken();
  } catch (err) {
    console.error("[import-playlist] client credentials failed", err);
    return NextResponse.json(
      { error: "spotify_auth", message: "Could not obtain Spotify app token" },
      { status: 500 }
    );
  }

  // ── Fetch playlist metadata ───────────────────────────────────
  // NOTE: do not request `tracks(total)` here — Spotify removed the `tracks`
  // object from playlist metadata (mid-2026 API change). The track total now
  // comes from the /items page below.
  const metaRes = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=id,name,description,owner(display_name)`,
    {
      headers: { Authorization: `Bearer ${ccToken}` },
      cache: "no-store",
    }
  );

  if (metaRes.status === 404) {
    return NextResponse.json(
      {
        error: "not_found",
        message:
          "Spotify couldn't find that playlist. Note: playlists made by Spotify itself " +
          "(like Today's Top Hits, Discover Weekly, or anything by the 'Spotify' account) " +
          "can't be imported — Spotify blocks app access to them. Try a playlist made by " +
          "a person, or one of your own.",
      },
      { status: 404 }
    );
  }
  if (metaRes.status === 403) {
    return NextResponse.json(
      {
        error: "private_playlist",
        message:
          "This playlist appears to be private. Please make it public in Spotify, then try again.",
      },
      { status: 403 }
    );
  }
  if (metaRes.status === 429) {
    const retryAfter = metaRes.headers.get("retry-after") ?? "30";
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `Spotify is rate-limiting requests. Try again in ~${retryAfter}s.`,
        retry_after: Number(retryAfter),
      },
      { status: 429 }
    );
  }
  if (!metaRes.ok) {
    console.error(`[import-playlist] playlist fetch failed: ${metaRes.status}`);
    return NextResponse.json(
      { error: "spotify_error", message: "Could not fetch playlist from Spotify." },
      { status: 502 }
    );
  }

  const playlistMeta = await metaRes.json();
  const playlistName: string = playlistMeta.name ?? "Imported Playlist";

  // ── Paginate tracks ──────────────────────────────────────────
  // Spotify's playlist content endpoints changed mid-2026 and behave
  // differently per token type. Try the newer /items endpoint first, then
  // fall back to the classic /tracks endpoint; both with an explicit
  // market (app tokens have no user country, and track relinking without a
  // market can return empty/blocked content).
  const allItems: SpotifyPlaylistTrackItem[] = [];
  let offset = 0;
  let totalTracks = 0;
  const upstreamStatuses: string[] = [];
  const endpoints = ["items", "tracks"] as const;

  for (const endpoint of endpoints) {
    offset = 0;
    totalTracks = 0;
    allItems.length = 0;
    let endpointFailed = false;

    while (offset < MAX_TRACKS) {
      const batchSize = Math.min(PAGE_SIZE, MAX_TRACKS - offset);
      const tracksRes = await fetch(
        `https://api.spotify.com/v1/playlists/${playlistId}/${endpoint}?offset=${offset}&limit=${batchSize}&market=US`,
        {
          headers: { Authorization: `Bearer ${ccToken}` },
          cache: "no-store",
        }
      );
      if (!tracksRes.ok) {
        upstreamStatuses.push(`${endpoint}:${tracksRes.status}`);
        console.error(
          `[import-playlist] ${endpoint} page fetch failed at offset=${offset}: ${tracksRes.status}`
        );
        endpointFailed = offset === 0;
        break; // Keep what we have so far for partial pages
      }
      const page = await tracksRes.json();
      if (typeof page.total === "number") totalTracks = page.total;
      const items: SpotifyPlaylistTrackItem[] = (page.items ?? []).map(normalizeEntry);
      if (items.length === 0) break;
      allItems.push(...items);
      offset += items.length;
      if (totalTracks > 0 && offset >= totalTracks) break;
    }

    if (!endpointFailed && allItems.length > 0) break; // success on this endpoint
  }

  if (allItems.length === 0) {
    // Distinguish "Spotify refused to share the songs" from a genuinely
    // empty playlist so users (and we) aren't told a full playlist is empty.
    if (upstreamStatuses.length > 0) {
      console.error(
        `[import-playlist] could not read playlist contents | playlist=${playlistId} | upstream=${upstreamStatuses.join(",")}`
      );
      return NextResponse.json(
        {
          error: "playlist_unreadable",
          message:
            "Spotify wouldn't share this playlist's songs with MusicLife " +
            `(${upstreamStatuses.join(", ")}). This can happen with playlists from ` +
            "Spotify itself or certain large curator accounts. Try a playlist made " +
            "by a person — or one of your own.",
        },
        { status: 502 }
      );
    }
    return NextResponse.json(
      {
        error: "empty_playlist",
        message:
          "This playlist has no tracks. Please use a playlist with at least a few songs.",
      },
      { status: 400 }
    );
  }

  // Filter out null/local tracks
  const validItems = allItems.filter(
    (item) => item.track?.id && item.track?.name
  );

  if (validItems.length === 0) {
    return NextResponse.json(
      {
        error: "no_valid_tracks",
        message: "No playable Spotify tracks found in this playlist.",
      },
      { status: 400 }
    );
  }

  // ── Supabase setup ────────────────────────────────────────────
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!sbUrl || !sbKey) {
    return NextResponse.json(
      { error: "Supabase not configured" },
      { status: 500 }
    );
  }
  const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });

  // ── Resolve or create user ────────────────────────────────────
  const existingSession = getSessionUser(req);
  let userId: string;
  let displayName: string;

  if (existingSession) {
    // Returning user — keep their existing ID
    userId = existingSession.userId;
    displayName = existingSession.displayName;

    // Update playlist source URL
    await sb
      .from("users")
      .update({ playlist_source_url: rawUrl })
      .eq("id", userId);
  } else {
    // New guest user
    userId = randomUUID();
    displayName = playlistName;

    const { error: insertErr } = await sb.from("users").insert({
      id: userId,
      spotify_user_id: null,
      display_name: displayName,
      auth_type: "playlist_import",
      playlist_source_url: rawUrl,
    });

    if (insertErr) {
      console.error("[import-playlist] user insert failed", insertErr.message);
      return NextResponse.json(
        { error: "user_create", message: "Could not create user account." },
        { status: 500 }
      );
    }
  }

  // ── Upsert artists ───────────────────────────────────────────
  // Collect unique artists from all tracks
  const artistMap = new Map<string, string>(); // spotify_artist_id → name
  for (const item of validItems) {
    for (const artist of item.track!.artists ?? []) {
      if (artist.id && artist.name && !artistMap.has(artist.id)) {
        artistMap.set(artist.id, artist.name);
      }
    }
  }

  // Batch upsert artists
  const artistRows = Array.from(artistMap.entries()).map(
    ([spotifyArtistId, name]) => ({
      spotify_artist_id: spotifyArtistId,
      name,
    })
  );

  if (artistRows.length > 0) {
    // Upsert in batches of 100
    for (let i = 0; i < artistRows.length; i += 100) {
      const batch = artistRows.slice(i, i + 100);
      await sb
        .from("artists")
        .upsert(batch, { onConflict: "spotify_artist_id", ignoreDuplicates: true });
    }
  }

  // Build spotify_artist_id → DB id lookup
  const artistIdLookup = new Map<string, number>();
  const spotifyArtistIds = Array.from(artistMap.keys());
  for (let i = 0; i < spotifyArtistIds.length; i += 100) {
    const batch = spotifyArtistIds.slice(i, i + 100);
    const { data: rows } = await sb
      .from("artists")
      .select("id, spotify_artist_id")
      .in("spotify_artist_id", batch);
    for (const row of rows ?? []) {
      artistIdLookup.set(row.spotify_artist_id, Number(row.id));
    }
  }

  // ── Upsert tracks ────────────────────────────────────────────
  function normalizeDate(d?: string): string | null {
    if (!d) return null;
    if (/^\d{4}$/.test(d)) return `${d}-01-01`;
    if (/^\d{4}-\d{2}$/.test(d)) return `${d}-01`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    return null;
  }

  const trackRows = validItems.map((item) => {
    const t = item.track!;
    const primaryArtist = (t.artists ?? []).find((a) => a.id);
    return {
      spotify_track_id: t.id!,
      artist_id: primaryArtist?.id
        ? artistIdLookup.get(primaryArtist.id) ?? null
        : null,
      name: t.name!,
      album_name: t.album?.name ?? null,
      duration_ms: t.duration_ms ?? null,
      explicit: t.explicit ?? null,
      popularity: t.popularity ?? null,
      release_date: normalizeDate(t.album?.release_date),
    };
  });

  // Batch upsert tracks
  for (let i = 0; i < trackRows.length; i += 100) {
    const batch = trackRows.slice(i, i + 100);
    await sb
      .from("tracks")
      .upsert(batch, { onConflict: "spotify_track_id", ignoreDuplicates: false });
  }

  // Build spotify_track_id → DB id lookup
  const trackIdLookup = new Map<string, number>();
  const spotifyTrackIds = validItems.map((item) => item.track!.id!);
  for (let i = 0; i < spotifyTrackIds.length; i += 100) {
    const batch = spotifyTrackIds.slice(i, i + 100);
    const { data: rows } = await sb
      .from("tracks")
      .select("id, spotify_track_id")
      .in("spotify_track_id", batch);
    for (const row of rows ?? []) {
      trackIdLookup.set(row.spotify_track_id, Number(row.id));
    }
  }

  // ── Create user_tracks entries ────────────────────────────────
  const userTrackRows = validItems
    .map((item) => {
      const dbTrackId = trackIdLookup.get(item.track!.id!);
      if (!dbTrackId) return null;
      return {
        user_id: userId,
        track_id: dbTrackId,
        added_at: item.added_at ?? new Date().toISOString(),
        play_count: 0,
      };
    })
    .filter(Boolean) as Array<{
    user_id: string;
    track_id: number;
    added_at: string;
    play_count: number;
  }>;

  for (let i = 0; i < userTrackRows.length; i += 100) {
    const batch = userTrackRows.slice(i, i + 100);
    await sb
      .from("user_tracks")
      .upsert(batch, { onConflict: "user_id,track_id", ignoreDuplicates: true });
  }

  await createTasteSnapshot({ sb, userId, reason: "playlist_import" });

  // ── Kick off enrichment pipeline ──────────────────────────────
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let jobId: string | null = null;

  if (apiUrl && serviceRoleKey) {
    try {
      const setupRes = await fetch(`${apiUrl}/ingest/setup-all`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({
          user_id: userId,
          spotify_access_token: ccToken,
          spotify_client_id: process.env.SPOTIFY_CLIENT_ID ?? "",
          spotify_client_secret: process.env.SPOTIFY_CLIENT_SECRET ?? "",
          skip_spotify_sync: true,
        }),
      });
      const setupData = await setupRes.json().catch(() => ({}));
      jobId = setupData.job_id ?? null;
    } catch (err) {
      console.error("[import-playlist] setup-all trigger failed", err);
      // Non-fatal — tracks are already in DB, user can re-trigger from dashboard
    }
  }

  // ── Build response with session cookies ───────────────────────
  const truncated = totalTracks > MAX_TRACKS;

  const res = NextResponse.json({
    ok: true,
    user_id: userId,
    display_name: displayName,
    playlist_name: playlistName,
    track_count: validItems.length,
    artist_count: artistMap.size,
    truncated,
    job_id: jobId,
  });

  // Set session cookies (same pattern as auth/callback)
  const opts = cookieOpts(secure);
  res.cookies.set("app_user_id", userId, opts);
  res.cookies.set("app_display_name", encodeURIComponent(displayName), opts);
  res.cookies.set("app_auth_type", "playlist_import", opts);

  console.log(
    `[import-playlist] success | user=${userId} | playlist=${playlistId} | tracks=${validItems.length} | artists=${artistMap.size}`
  );

  return res;
}
