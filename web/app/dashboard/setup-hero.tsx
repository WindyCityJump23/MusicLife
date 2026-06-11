"use client";

import { useState } from "react";
import SetupAllButton, { type SetupStatusSnapshot } from "./SetupAllButton";
import { useAuth } from "./auth-context";
import { useReadiness } from "./readiness-context";
import { completedStepNumbers, toRadioReadiness } from "@/lib/readiness";

/**
 * The single setup surface.
 *
 * Replaces the previous trio (SetupBanner + RadioSetupGate + the sidebar
 * accordion) that put three different progress representations and three
 * "set up" buttons on screen at once — the main source of "I don't know how
 * to use any of it" feedback. New accounts auto-start setup, so connecting
 * Spotify is the only action a user has to take; this card just narrates
 * progress in plain words until the station is ready.
 */

const STEP_LABELS_SPOTIFY = [
  "Reading your Spotify library",
  "Learning your artists",
  "Connecting your taste",
  "Checking the music press",
  "Finding songs to play",
  "Sharpening matches",
];

const STEP_LABELS_GUEST = [
  "Reading your playlist",
  "Learning your artists",
  "Connecting your taste",
  "Checking the music press",
  "Finding songs to play",
  "Sharpening matches",
];

export default function SetupHero({
  onComplete,
}: {
  onComplete?: () => void;
}) {
  const { isGuest } = useAuth();
  const { data, refresh } = useReadiness();
  const [setupStatus, setSetupStatus] = useState<SetupStatusSnapshot | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const stepLabels = isGuest ? STEP_LABELS_GUEST : STEP_LABELS_SPOTIFY;
  const completedSteps = completedStepNumbers(data?.readiness?.steps);
  const readiness = data ? toRadioReadiness(data) : null;

  const isRunning = setupStatus?.state === "running";
  const coldStart = completedSteps.size === 0;
  const doneCount = completedSteps.size;
  const activeStep =
    isRunning && setupStatus && setupStatus.step > 0
      ? setupStatus.step
      : (stepLabels.findIndex((_, i) => !completedSteps.has(i + 1)) + 1 || stepLabels.length);

  const title = isRunning
    ? "Building your station…"
    : coldStart
    ? "Setting up your station"
    : "Finish setting up your station";
  const body = isRunning
    ? "This takes a few minutes. You can leave and come back — it keeps running."
    : coldStart
    ? "MusicLife reads your music, learns your taste, and lines up songs to play."
    : "A previous setup didn't finish. Continue to get your station playing.";

  return (
    <section className="max-w-3xl rounded-lg border border-neutral-200 bg-white overflow-hidden">
      <div className="p-6 sm:p-8 space-y-5">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-emerald-600 font-bold">
            MusicLife Radio
          </p>
          <h3 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-neutral-950">
            {title}
          </h3>
          <p className="mt-2 text-sm text-neutral-500 leading-relaxed max-w-lg">{body}</p>
        </div>

        {/* One progress representation: the step strip. */}
        <div className="space-y-2">
          <div className="flex gap-1" aria-hidden="true">
            {stepLabels.map((label, i) => (
              <div
                key={label}
                className={[
                  "h-1.5 flex-1 rounded-full transition-colors",
                  completedSteps.has(i + 1)
                    ? "bg-emerald-500"
                    : isRunning && activeStep === i + 1
                    ? "bg-emerald-300 animate-pulse"
                    : "bg-neutral-200",
                ].join(" ")}
              />
            ))}
          </div>
          <p className="text-xs text-neutral-500">
            {isRunning
              ? setupStatus?.message || `Step ${activeStep} of ${stepLabels.length}: ${stepLabels[activeStep - 1]}`
              : `${doneCount} of ${stepLabels.length} steps complete`}
          </p>
        </div>

        <div className="max-w-sm">
          <SetupAllButton
            autoStart={coldStart}
            onProgress={() => void refresh()}
            onComplete={onComplete}
            onStatusChange={setSetupStatus}
          />
        </div>

        {readiness && readiness.artistCount > 0 && (
          <div className="flex gap-2">
            <HeroStat
              label="Artists learned"
              value={`${readiness.embeddedCount}/${Math.max(readiness.requiredArtistCount, readiness.embeddedCount)}`}
            />
            <HeroStat
              label="Songs ready"
              value={`${readiness.playableTrackCount}/${Math.max(readiness.requiredPlayableTrackCount, readiness.playableTrackCount)}`}
            />
          </div>
        )}

        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-[11px] text-neutral-400 hover:text-neutral-600 transition-colors"
          aria-expanded={showDetails}
        >
          {showDetails ? "Hide details ▴" : "What happens during setup? ▾"}
        </button>

        {showDetails && (
          <ol className="space-y-1.5">
            {stepLabels.map((label, i) => {
              const done = completedSteps.has(i + 1);
              return (
                <li key={label} className="flex items-center gap-2 text-xs">
                  <span
                    className={[
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold",
                      done ? "bg-emerald-500 text-white" : "bg-neutral-200 text-neutral-500",
                    ].join(" ")}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span className={done ? "text-neutral-500" : "text-neutral-700"}>{label}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
      <p className="text-[10px] text-neutral-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-neutral-900 tabular-nums">{value}</p>
    </div>
  );
}
