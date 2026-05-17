"use client";

import { useEffect, useState } from "react";
import DiscoverView from "./discover-view";
import SetupAllButton from "./SetupAllButton";

type RadioReadiness = {
  loading: boolean;
  ready: boolean;
  artistCount: number;
  enrichedCount: number;
  embeddedCount: number;
  playableTrackCount: number;
  requiredArtistCount: number;
  requiredPlayableTrackCount: number;
};

const EMPTY_READINESS: RadioReadiness = {
  loading: true,
  ready: false,
  artistCount: 0,
  enrichedCount: 0,
  embeddedCount: 0,
  playableTrackCount: 0,
  requiredArtistCount: 0,
  requiredPlayableTrackCount: 0,
};

export default function RadioView({
  onNavigate,
}: {
  onNavigate?: (view: string) => void;
}) {
  const [readiness, setReadiness] = useState<RadioReadiness>(EMPTY_READINESS);

  async function refreshReadiness(): Promise<RadioReadiness> {
    try {
      const res = await fetch("/api/readiness", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not check radio setup");

      const serverReadiness = data.readiness ?? {};
      const artistCount = data.stats?.artistCount ?? 0;
      const requiredArtistCount =
        serverReadiness.requiredArtistCount ??
        Math.min(artistCount, Math.max(5, Math.ceil(artistCount * 0.25)));
      const playableTrackCount =
        serverReadiness.playableTrackCount ?? data.stats?.playableTrackCount ?? 0;
      const requiredPlayableTrackCount =
        serverReadiness.requiredPlayableTrackCount ??
        Math.min(50, Math.max(10, requiredArtistCount * 3));
      const ready =
        typeof serverReadiness.radioReady === "boolean"
          ? serverReadiness.radioReady
          : artistCount > 0 &&
            (serverReadiness.enrichedCount ?? 0) >= requiredArtistCount &&
            (serverReadiness.embeddedCount ?? 0) >= requiredArtistCount &&
            playableTrackCount >= requiredPlayableTrackCount;

      const next = {
        loading: false,
        ready,
        artistCount,
        enrichedCount: serverReadiness.enrichedCount ?? 0,
        embeddedCount: serverReadiness.embeddedCount ?? 0,
        playableTrackCount,
        requiredArtistCount,
        requiredPlayableTrackCount,
      };
      setReadiness(next);
      return next;
    } catch {
      const next = { ...EMPTY_READINESS, loading: false };
      setReadiness(next);
      return next;
    }
  }

  useEffect(() => {
    void refreshReadiness();
  }, []);

  if (readiness.loading) return <RadioLoading />;

  if (!readiness.ready) {
    return (
      <RadioSetupGate
        readiness={readiness}
        onProgress={() => void refreshReadiness()}
        onComplete={() => void refreshReadiness()}
      />
    );
  }

  return (
    <div className="max-w-none">
      <DiscoverView onNavigate={onNavigate} readiness={readiness} />
    </div>
  );
}

function RadioLoading() {
  return (
    <div className="max-w-4xl rounded-lg border border-neutral-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <div className="h-4 w-36 rounded bg-neutral-100 animate-pulse" />
          <div className="h-3 w-64 max-w-full rounded bg-neutral-100 animate-pulse" />
        </div>
        <div className="h-10 w-10 rounded-full bg-neutral-100 animate-pulse" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-16 rounded-md bg-neutral-50 border border-neutral-100 animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}

function RadioSetupGate({
  readiness,
  onProgress,
  onComplete,
}: {
  readiness: RadioReadiness;
  onProgress: () => void;
  onComplete: () => void;
}) {
  const tracksNeeded = Math.max(
    0,
    readiness.requiredPlayableTrackCount - readiness.playableTrackCount
  );

  return (
    <section className="max-w-4xl rounded-lg border border-neutral-200 bg-white overflow-hidden">
      <div className="p-5 sm:p-6 grid gap-5 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.22em] text-emerald-600 font-bold">
              Radio setup
            </p>
            <h3 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-neutral-950">
              Build your first station.
            </h3>
            <p className="mt-2 text-sm text-neutral-500 leading-relaxed max-w-xl">
              MusicLife builds a taste profile first, then prepares enough
              playable catalog tracks from your artists to make radio feel immediate.
            </p>
          </div>

          <SetupAllButton onProgress={onProgress} onComplete={onComplete} />
        </div>

        <div className="grid grid-cols-3 lg:grid-cols-1 gap-2">
          <ReadinessTile
            label="Artists imported"
            value={readiness.artistCount}
            ready={readiness.artistCount > 0}
          />
          <ReadinessTile
            label="Taste modeled"
            value={`${readiness.embeddedCount}/${readiness.requiredArtistCount}`}
            ready={
              readiness.requiredArtistCount > 0 &&
              readiness.embeddedCount >= readiness.requiredArtistCount
            }
          />
          <ReadinessTile
            label="Catalog tracks"
            value={
              tracksNeeded > 0
                ? `${readiness.playableTrackCount}/${readiness.requiredPlayableTrackCount}`
                : readiness.playableTrackCount
            }
            ready={
              readiness.requiredPlayableTrackCount > 0 &&
              readiness.playableTrackCount >= readiness.requiredPlayableTrackCount
            }
          />
        </div>
      </div>
    </section>
  );
}

function ReadinessTile({
  label,
  value,
  ready,
}: {
  label: string;
  value: number | string;
  ready: boolean;
}) {
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-neutral-500">{label}</p>
        <span className={ready ? "text-emerald-600" : "text-neutral-300"}>
          {ready ? "✓" : "○"}
        </span>
      </div>
      <p className="mt-1 text-sm font-semibold text-neutral-900 tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}
