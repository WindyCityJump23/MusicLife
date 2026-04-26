import SyncButton from "./SyncButton";

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
          <SyncButton />
        </section>
      </div>
    </main>
  );
}
