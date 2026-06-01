"use client";

import { useEffect, useRef, useState } from "react";
import SetupAllButton, { type SetupStatusSnapshot } from "./SetupAllButton";
import { useAuth } from "./auth-context";

type ReadinessStats = {
  artistCount?: number;
  trackCount?: number;
  playableTrackCount?: number;
  modeledTrackCount?: number;
  mentionCount?: number;
};

const STEP_LABELS_SPOTIFY = [
  { title: "Import Spotify library", body: "Saved songs, artists, and recent plays" },
  { title: "Learn artist taste", body: "Genres and artist metadata" },
  { title: "Connect your taste", body: "Prepare stronger station matches" },
  { title: "Add music context", body: "Editorial and source signals" },
  { title: "Prepare playable songs", body: "Spotify tracks for your artists" },
  { title: "Refine discovery", body: "Improve song-level matching over time" },
];

const STEP_LABELS_GUEST = [
  { title: "Import playlist", body: "Artists and tracks from your playlist" },
  { title: "Learn artist taste", body: "Genres and artist metadata" },
  { title: "Connect your taste", body: "Prepare stronger station matches" },
  { title: "Add music context", body: "Editorial and source signals" },
  { title: "Prepare playable songs", body: "Tracks for recommendations" },
  { title: "Refine discovery", body: "Improve song-level matching over time" },
];

export default function SetupBanner({
  onSetupComplete,
}: {
  onSetupComplete?: () => void;
}) {
  const { isGuest } = useAuth();
  const STEP_LABELS = isGuest ? STEP_LABELS_GUEST : STEP_LABELS_SPOTIFY;
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [stats, setStats] = useState<ReadinessStats | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatusSnapshot | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const checkedRef = useRef(false);

  function checkReadiness() {
    fetch("/api/readiness")
      .then((r) => r.json())
      .then((data) => {
        const done = new Set<number>();
        const steps = data.readiness?.steps;
        if (steps?.imported) done.add(1);
        if (steps?.enriched) done.add(2);
        if (steps?.embedded) done.add(3);
        if (steps?.context) done.add(4);
        if (steps?.tracks) done.add(5);
        if (steps?.modeledTracks) done.add(6);
        setCompletedSteps(done);
        setStats(data.stats ?? null);
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    checkReadiness();
  }, []);

  useEffect(() => {
    const id = setInterval(checkReadiness, 30_000);
    return () => clearInterval(id);
  }, []);

  const allDone = completedSteps.size >= 6;
  const noneStarted = completedSteps.size === 0;
  const isRunning = setupStatus?.state === "running";
  const firstMissingStep =
    STEP_LABELS.findIndex((_, i) => !completedSteps.has(i + 1)) + 1 || STEP_LABELS.length;
  const activeStep = isRunning && setupStatus.step > 0 ? setupStatus.step : firstMissingStep;

  if (allDone || dismissed) return null;

  return (
    <div className="rounded-xl border border-emerald-200 bg-white p-4 sm:p-5 space-y-4 mb-4 lg:mb-6 shadow-sm shadow-emerald-100/60">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-neutral-900 flex items-center gap-2">
            <span className="text-base">🎶</span>
            {noneStarted ? "Build your music profile" : isRunning ? "Building your music profile" : "Profile setup in progress"}
          </h3>
          <p className="text-xs text-neutral-500 mt-1 leading-relaxed">
            {noneStarted
              ? "MusicLife needs one setup pass before Discover feels personal. Larger libraries can take several minutes, and you can come back while it runs."
              : isRunning
              ? setupStatus?.message || `${completedSteps.size} of 6 steps complete.`
              : `${completedSteps.size} of 6 steps complete. Continue setup to finish the remaining steps.`}
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss setup banner"
          className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SetupStat label="Saved tracks" value={stats?.trackCount} />
        <SetupStat label="Artists" value={stats?.artistCount} />
        <SetupStat label="Playable songs" value={stats?.playableTrackCount} />
        <SetupStat label="Discovery-ready songs" value={stats?.modeledTrackCount} />
      </div>

      <div className="space-y-2">
        <div className="flex gap-1">
          {STEP_LABELS.map((step, i) => (
            <div
              key={step.title}
              className={[
                "h-1.5 flex-1 rounded-full transition-colors",
                completedSteps.has(i + 1)
                  ? "bg-emerald-500"
                  : activeStep === i + 1
                  ? "bg-emerald-300"
                  : "bg-neutral-200",
              ].join(" ")}
              title={`Step ${i + 1}: ${step.title}`}
            />
          ))}
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {STEP_LABELS.map((step, i) => {
            const stepNumber = i + 1;
            const done = completedSteps.has(stepNumber);
            const active = !done && activeStep === stepNumber;
            return (
              <div
                key={step.title}
                className={[
                  "rounded-lg border px-3 py-2 min-h-[64px]",
                  done
                    ? "border-emerald-100 bg-emerald-50/80"
                    : active
                    ? "border-emerald-200 bg-white"
                    : "border-neutral-100 bg-neutral-50/70",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                      done
                        ? "bg-emerald-500 text-white"
                        : active
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-neutral-200 text-neutral-500",
                    ].join(" ")}
                  >
                    {done ? "✓" : stepNumber}
                  </span>
                  <p className="text-xs font-medium text-neutral-800 truncate">
                    {step.title}
                  </p>
                </div>
                <p className="mt-1 pl-7 text-[10px] leading-snug text-neutral-500">
                  {active && isRunning ? setupStatus?.message || step.body : step.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {stats?.mentionCount ? (
        <p className="text-[10px] text-neutral-400 leading-relaxed">
          Current context includes {stats.mentionCount.toLocaleString()} music-source mention
          {stats.mentionCount === 1 ? "" : "s"} for discovery and buzz signals.
        </p>
      ) : null}

      <div className="max-w-sm">
        <SetupAllButton
          isReady={false}
          onProgress={checkReadiness}
          onComplete={onSetupComplete}
          onStatusChange={setSetupStatus}
        />
      </div>
    </div>
  );
}

function SetupStat({
  label,
  value,
}: {
  label: string;
  value?: number;
}) {
  return (
    <div className="rounded-lg border border-neutral-100 bg-neutral-50/70 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-neutral-900">
        {typeof value === "number" ? value.toLocaleString() : "—"}
      </p>
    </div>
  );
}
