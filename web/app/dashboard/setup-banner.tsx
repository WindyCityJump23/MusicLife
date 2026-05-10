"use client";

import { useEffect, useRef, useState } from "react";
import SetupAllButton from "./SetupAllButton";

const STEP_LABELS = [
  "Import listening history",
  "Learn your taste",
  "Build your radio model",
  "Add music context",
  "Prepare song catalog",
  "Model songs",
];

export default function SetupBanner({
  onSetupComplete,
}: {
  onSetupComplete?: () => void;
}) {
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
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

  if (allDone || dismissed) return null;

  return (
    <div className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-4 sm:p-5 space-y-3 mb-4 lg:mb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-neutral-900 flex items-center gap-2">
            <span className="text-base">🎶</span>
            {noneStarted ? "Set up your music profile" : "Profile setup in progress"}
          </h3>
          <p className="text-xs text-neutral-500 mt-1 leading-relaxed">
            {noneStarted
              ? "One click imports your Spotify taste and builds your personal radio model. Takes about 2 minutes."
              : `${completedSteps.size} of 6 steps complete. Run setup to finish the remaining steps.`}
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

      {/* Step indicators */}
      <div className="flex gap-1">
        {STEP_LABELS.map((label, i) => (
          <div
            key={i}
            className={[
              "h-1.5 flex-1 rounded-full transition-colors",
              completedSteps.has(i + 1)
                ? "bg-emerald-500"
                : "bg-neutral-200",
            ].join(" ")}
            title={`Step ${i + 1}: ${label}`}
          />
        ))}
      </div>

      <div className="max-w-xs">
        <SetupAllButton
          isReady={false}
          onProgress={checkReadiness}
          onComplete={onSetupComplete}
        />
      </div>
    </div>
  );
}
