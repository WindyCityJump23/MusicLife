import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import PlaylistImportForm from "./playlist-import-form";

const ERROR_MESSAGES: Record<string, string> = {
  no_code: "Spotify sign-in did not finish. Please try again.",
  state_mismatch: "Sign-in session expired. Please try again.",
  token_exchange: "Spotify sign-in could not be completed. Please try again.",
  token_missing: "Spotify sign-in could not be completed. Please try again.",
  profile_fetch: "Could not fetch your Spotify profile. This may be a temporary Spotify issue — please try again in a moment.",
  forbidden: "Spotify needs you to reconnect. Please try again.",
  token_invalid: "Spotify needs you to reconnect. Please try again.",
  rate_limited: "Spotify is rate-limiting login requests right now. Please wait a moment and try again.",
  user_upsert: "Your account could not be created or updated. Please try again.",
};

export default function Home({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  // Auto-redirect logged-in users to dashboard (unless there's an error to show)
  const hasError = typeof searchParams.error === "string";
  if (!hasError) {
    const cookieStore = cookies();
    const userId = cookieStore.get("app_user_id")?.value;
    if (userId) {
      redirect("/dashboard");
    }
  }

  const errorKey = typeof searchParams.error === "string" ? searchParams.error : null;
  const retryAfter = typeof searchParams.retry_after === "string" ? searchParams.retry_after : null;
  const baseMessage = errorKey ? (ERROR_MESSAGES[errorKey] ?? "An unexpected error occurred. Please try again.") : null;
  const retrySuffix = retryAfter ? ` Please try again in about ${retryAfter} seconds.` : "";
  const errorMessage = baseMessage
    ? `${baseMessage}${retrySuffix}`
    : null;

  return (
    <main
      className="min-h-screen flex items-center justify-center px-5 py-8 sm:p-8"
      style={{ background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)" }}
    >
      <div className="max-w-md w-full text-center space-y-8 sm:space-y-10 pt-safe pb-safe">

        {/* ── Hero ─────────────────────────────────────────── */}
        <div className="space-y-3">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-white">
            MusicLife
          </h1>
          <p className="text-sm sm:text-base text-white/70 leading-relaxed">
            Personal radio that learns your taste and finds songs worth playing next.
          </p>
        </div>

        {/* ── Error banner ─────────────────────────────────── */}
        {errorMessage && (
          <div className="rounded-xl border border-red-400/30 bg-red-900/30 px-4 py-3 text-sm text-red-300 text-left">
            {errorMessage}
          </div>
        )}

        {/* ── CTA: Connect with Spotify ─────────────────── */}
        <div className="space-y-3">
          <a
            href="/api/auth/login?force=1"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-white text-neutral-900 px-7 sm:px-8 py-3 text-sm font-medium hover:bg-white/90 active:bg-white/80 transition w-full sm:w-auto"
          >
            <SpotifyIcon />
            Connect with Spotify
          </a>
          <p className="text-xs text-white/45 leading-relaxed max-w-xs mx-auto">
            Full experience with in-browser playback, library sync, and playlists.
          </p>
        </div>

        {/* ── Divider ─────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-white/10" />
          <span className="text-xs text-white/30 font-medium">or</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>

        {/* ── CTA: Playlist Import ────────────────────────── */}
        <PlaylistImportForm />

        {/* ── How it works ─────────────────────────────────── */}
        <div className="border-t border-white/10 pt-6 sm:pt-8">
          <p className="text-xs uppercase tracking-widest text-white/40 font-medium mb-5 sm:mb-6">
            How it works
          </p>
          <div className="grid grid-cols-3 gap-3 sm:gap-4">
            <HowStep
              emoji="🔗"
              step="1"
              title="Connect"
              desc="Link your Spotify account securely"
            />
            <HowStep
              emoji="⚡"
              step="2"
              title="Sync"
              desc="Import your library & listening history"
            />
            <HowStep
              emoji="✨"
              step="3"
              title="Discover"
              desc="Get a station shaped by your taste"
            />
          </div>
        </div>

        <p className="text-xs text-white/40 px-2">
          Your data stays private. No ads. No algorithms selling your taste.
        </p>
      </div>
    </main>
  );
}

function HowStep({
  emoji,
  step,
  title,
  desc,
}: {
  emoji: string;
  step: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/10 flex items-center justify-center text-2xl">
        {emoji}
      </div>
      <div>
        <p className="text-xs font-semibold text-white">{title}</p>
        <p className="text-[11px] text-white/50 leading-snug mt-0.5">{desc}</p>
      </div>
    </div>
  );
}

function SpotifyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}
