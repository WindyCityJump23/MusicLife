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
    title: "Sync Your Library",
    desc: "Import your Spotify artists & listening history.",
    icon: "🔗",
  },
  {
    id: 2,
    title: "Enrich Artists",
    desc: "Fetch genres, tags & metadata for each artist.",
    icon: "⚡",
  },
  {
    id: 3,
    title: "Generate Embeddings",
    desc: "Build AI taste vectors for smart matching.",
    icon: "🧠",
  },
  {
    id: 4,
    title: "Sync Sources",
    desc: "Add editorial content (blogs, charts, reviews).",
    icon: "📰",
  },
] as const;

export default function OnboardingWizard() {
  const [visible, setVisible] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    // Check localStorage first — if dismissed, don't show
    try {
      if (localStorage.getItem(STORAGE_KEY) === "true") return;
    } catch {}

    // Check if user has 0 artists synced
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome — set up your library"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-neutral-100">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900">
                Welcome to MusicLife 🎶
              </h2>
              <p className="text-sm text-neutral-500 mt-0.5">
                Let&apos;s set up your library in 4 quick steps.
              </p>
            </div>
            <button
              onClick={dismiss}
              aria-label="Skip onboarding"
              className="shrink-0 text-xs text-neutral-400 hover:text-neutral-600 mt-1 whitespace-nowrap transition-colors"
            >
              Skip for now
            </button>
          </div>

          {/* Step progress bar */}
          <div className="flex gap-1.5 mt-4">
            {STEPS.map((s) => (
              <div
                key={s.id}
                className={[
                  "h-1.5 flex-1 rounded-full transition-colors",
                  s.id < currentStep
                    ? "bg-emerald-500"
                    : s.id === currentStep
                    ? "bg-emerald-400"
                    : "bg-neutral-200",
                ].join(" ")}
              />
            ))}
          </div>
        </div>

        {/* Current step */}
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center text-2xl shrink-0">
              {step.icon}
            </div>
            <div>
              <p className="text-sm font-semibold text-neutral-900">
                Step {step.id}: {step.title}
              </p>
              <p className="text-xs text-neutral-500 mt-0.5 leading-relaxed">
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
              className="text-xs text-neutral-400 hover:text-neutral-600 transition-colors"
            >
              {currentStep < STEPS.length ? "Skip this step →" : "Finish later"}
            </button>
            <span className="text-xs text-neutral-400">
              {currentStep} / {STEPS.length}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
