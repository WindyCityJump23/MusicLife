import { randomBytes } from "crypto";
import { NextResponse } from "next/server";

// Spotify OAuth — authorization code flow.
// Scopes cover: read library, read listens, control playback, Web Playback SDK.
const SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-library-read",
  "user-top-read",
  "user-read-recently-played",
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-library-modify",
].join(" ");

export async function GET() {
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SPOTIFY_CLIENT_ID!,
    scope: SCOPES,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI!,
    state
  });
  const res = NextResponse.redirect(
    `https://accounts.spotify.com/authorize?${params.toString()}`
  );

  res.cookies.set("sp_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  });

  return res;
}
