// The dashboard. Three zones:
//   Left rail:  saved curated views, source filter
//   Center:     prompt box + ranked recommendation cards
//   Right rail: playback + "now playing" + why-this synthesis
//
// Week 1 goal: render anything real here once OAuth succeeds.
// Week 4 goal: full layout wired to /recommend and /synthesize.

export default function Dashboard() {
  return (
    <main className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <header>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-neutral-500 text-sm">
            Connected. Next: ingest your library.
          </p>
        </header>

        <section className="border rounded-lg p-6">
          <p className="text-sm text-neutral-500">
            Placeholder. Wire to the API&apos;s /ingest/spotify-library endpoint,
            then render the user&apos;s top artists as a sanity check.
          </p>
        </section>
      </div>
    </main>
  );
}
