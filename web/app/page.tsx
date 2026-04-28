export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8 bg-white">
      <div className="max-w-md w-full text-center space-y-8">
        <div className="space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight text-neutral-900">
            MusicLife
          </h1>
          <p className="text-neutral-500 leading-relaxed">
            Discover music you'll actually like. Powered by your Spotify
            listening history, editorial sources, and AI taste matching.
          </p>
        </div>

        <a
          href="/api/auth/login"
          className="inline-flex items-center gap-2 rounded-full bg-neutral-900 text-white px-8 py-3 text-sm font-medium hover:bg-neutral-700 transition"
        >
          <SpotifyIcon />
          Connect with Spotify
        </a>

        <p className="text-xs text-neutral-400">
          Your data stays private. No ads. No algorithms selling your taste.
        </p>
      </div>
    </main>
  );
}

function SpotifyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}
