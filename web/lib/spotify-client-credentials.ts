/**
 * Server-side Spotify Client Credentials token.
 *
 * Obtains an app-level token (no user auth) for reading public resources
 * like playlists. Caches the token in-memory with a 60s safety buffer.
 *
 * Uses the same SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET env vars that
 * the user-auth flow already depends on.
 */

const REFRESH_BUFFER_MS = 60_000;

let cachedToken: string | null = null;
let cachedExpiresAt = 0;
let inflightPromise: Promise<string> | null = null;

export async function getClientCredentialsToken(): Promise<string> {
  // Return cached token if still valid
  if (cachedToken && cachedExpiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return cachedToken;
  }

  // Deduplicate concurrent callers — only one token exchange at a time
  if (inflightPromise) return inflightPromise;

  inflightPromise = fetchClientCredentialsToken();
  try {
    const token = await inflightPromise;
    return token;
  } finally {
    inflightPromise = null;
  }
}

async function fetchClientCredentialsToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set for client credentials flow"
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(
      `Spotify client credentials token exchange failed: ${res.status}`
    );
  }

  const data = await res.json();
  if (typeof data.access_token !== "string") {
    throw new Error("Spotify client credentials response missing access_token");
  }

  const expiresIn = Number(data.expires_in) || 3600;
  cachedToken = data.access_token;
  cachedExpiresAt = Date.now() + expiresIn * 1000;

  return cachedToken as string;
}
