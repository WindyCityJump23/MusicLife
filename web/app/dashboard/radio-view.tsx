"use client";

import DiscoverView from "./discover-view";
import SetupHero from "./setup-hero";
import { useReadiness } from "./readiness-context";
import {
  EMPTY_RADIO_READINESS,
  toRadioReadiness,
  type RadioReadiness,
} from "@/lib/readiness";

export default function RadioView({
  onNavigate,
}: {
  onNavigate?: (view: string) => void;
}) {
  const { data, loading, refresh } = useReadiness();

  const readiness: RadioReadiness = data
    ? toRadioReadiness(data)
    : { ...EMPTY_RADIO_READINESS, loading };

  if (readiness.loading) return <RadioLoading />;

  if (!readiness.ready) {
    return <SetupHero onComplete={() => void refresh()} />;
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
