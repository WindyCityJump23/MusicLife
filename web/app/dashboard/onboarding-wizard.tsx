"use client";

import { useEffect, useRef, useState } from "react";
import SyncButton from "./SyncButton";
import EnrichButton from "./EnrichButton";
import EmbedButton from "./EmbedButton";
import SourcesButton from "./SourcesButton";

const STORAGE_KEY = "musiclife_onboarding_dismissed";

const STEPS = [
  {
    id: 1,
    title: "Sync Library",
    desc: "Import your Spotify artists & listening history.",
    icon: "🔗",
  },
  {
    id: 2,
    title: "Enrich Artists",
    desc: "Fetch genres & metadata.",
    icon: "⚡",
  },
  {
    id: 3,
    title: "Generate Embeddings",
    desc: "Build AI taste vectors.",
    icon: "🧠",
  },
  {
    id: 4,
    title: "Sync Sources",
    desc: "Add editorial content.",
    icon: "📰",
  },
] as const;

export default function OnboardingWizard() {
  const [visible, setVisible] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [minimized, setMinimized] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    try {
      if (localStorage.getItem(STORAGE_KEY) === "true") return;
    } catch {}

    fetch("/api/library")
      .then((r) => r.json())
      .then((data) => {
        const artistCount: number = data.stats?.artistCount ?? 0;
        if (artistCount === 0) setVisible(true);
      })
      .catch(() => {});
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {}
    setVisible(false);
  }

  function handleStepComplete() {
    if (currentStep < STEPS.length) {
      setCurrentStep(currentStep + 1);
    } else {
      dismiss();
    }
  }

  function handleSkipStep() {
    if (currentStep < STEPS.length) {
      setCurrentStep(currentStep + 1);
    } else {
      dismiss();
    }
  }

  if (!visible) return null;

  const step = STEPS[currentStep - 1];

  // Minimized state: just a floating pill at the top
  if (minimized) {
    return (
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] animate-fade-in">
        <button
          onClick={() => setMinimized(false)}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-full shadow-lg hover:bg-emerald-700 transition-colors text-xs font-medium"
        >
          <span>🎶</span>
          <span>Setup ({currentStep}/{STEPS.length})</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] w-full max-w-lg mx-auto px-3 animate-fade-in">
      <div className="bg-white rounded-xl shadow-xl border border-neutral-200 overflow-hidden">
        {/* Header — compact */}
        <div className="px-4 py-3 flex items-center justify-between gap-2 border-b border-neutral-100">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base">🎶</span>
            <span className="text-sm font-semibold text-neutral-900 truncate">
              Welcome — set up your library
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setMinimized(true)}
              aria-label="Minimize setup"
              className="w-7 h-7 rounded-md flex items-center justify-center text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
              title="Minimize"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M5 12h14" />
              </svg>
            </button>
            <button
              onClick={dismiss}
              aria-label="Dismiss setup"
              className="w-7 h-7 rounded-md flex items-center justify-center text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
              title="Skip for now"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M6 18L18 6" />
              </svg>
            </button>
          </div>
        </div>

        {/* Step progress dots */}
        <div className="flex gap-1.5 px-4 pt-3">
          {STEPS.map((s) => (
            <div
              key={s.id}
              className={[
                "h-1 flex-1 rounded-full transition-colors",
                s.id < currentStep
                  ? "bg-emerald-500"
                  : s.id === currentStep
                  ? "bg-emerald-400"
                  : "bg-neutral-200",
              ].join(" ")}
            />
          ))}
        </div>

        {/* Current step — compact */}
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-50 flex items-center justify-center text-lg shrink-0">
              {step.icon}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-neutral-900">
                Step {step.id}: {step.title}
              </p>
              <p className="text-[11px] text-neutral-500 leading-snug">
                {step.desc}
              </p>
            </div>
          </div>

          <div>
            {step.id === 1 && <SyncButton onComplete={handleStepComplete} />}
            {step.id === 2 && <EnrichButton onComplete={handleStepComplete} />}
            {step.id === 3 && <EmbedButton onComplete={handleStepComplete} />}
            {step.id === 4 && (
              <SourcesButton onComplete={handleStepComplete} />
            )}
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={handleSkipStep}
              className="text-[11px] text-neutral-400 hover:text-neutral-600 transition-colors"
            >
              {currentStep < STEPS.length ? "Skip →" : "Finish"}
            </button>
            <span className="text-[11px] text-neutral-400">
              {currentStep} / {STEPS.length}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
