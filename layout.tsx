export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-xl text-center space-y-6">
        <h1 className="text-4xl font-semibold tracking-tight">
          Music Dashboard
        </h1>
        <p className="text-neutral-500">
          A discovery surface that listens to the open web, not an algorithm.
        </p>
        <a
          href="/api/auth/login"
          className="inline-block rounded-full bg-neutral-900 text-white px-6 py-3 text-sm font-medium hover:bg-neutral-800 transition"
        >
          Connect Spotify
        </a>
      </div>
    </main>
  );
}
