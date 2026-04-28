export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center px-5 py-8 sm:p-8 bg-white">
      <div className="max-w-md w-full text-center space-y-8 sm:space-y-10 pt-safe pb-safe">

        {/* ── Hero ─────────────────────────────────────────── */}
        <div className="space-y-3">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-neutral-900">
            MusicLife
          </h1>
          <p className="text-sm sm:text-base text-neutral-500 leading-relaxed">
            Discover music you&apos;ll actually like. Powered by your Spotify
            listening history, editorial sources, and AI taste matching.
          </p>
        </div>

        {/* ── CTA ──────────────────────────────────────────── */}
        <a
          href="/api/auth/login"
          className="inline-flex items-center justify-center gap-2 rounded-full bg-neutral-900 text-white px-7 sm:px-8 py-3 text-sm font-medium hover:bg-neutral-700 active:bg-neutral-800 transition w-full sm:w-auto"
        >
          <SpotifyIcon />
          Connect with Spotify
        </a>

        {/* ── How it works ─────────────────────────────────── */}
        <div className="border-t border-neutral-100 pt-6 sm:pt-8">
          <p className="text-xs uppercase tracking-widest text-neutral-400 font-medium mb-5 sm:mb-6">
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
              desc="Get AI-powered recommendations"
            />
          </div>
        </div>

        <p className="text-xs text-neutral-400 px-2">
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
      <div className="w-12 h-12 rounded-2xl bg-neutral-50 border border-neutral-100 flex items-center justify-center text-2xl">
        {emoji}
      </div>
      <div>
        <p className="text-xs font-semibold text-neutral-800">{title}</p>
        <p className="text-[11px] text-neutral-400 leading-snug mt-0.5">{desc}</p>
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
