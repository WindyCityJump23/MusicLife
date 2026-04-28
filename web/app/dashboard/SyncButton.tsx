"use client";

import { useEffect, useRef, useState } from "react";

type SyncState = "idle" | "syncing" | "success" | "error";

// Simulated progress stages matching the backend pipeline:
// 1. Fetching saved tracks  (0-30%)
// 2. Fetching top artists   (30-50%)
// 3. Fetching recent plays  (50-65%)
// 4. Upserting artists      (65-80%)
// 5. Upserting tracks       (80-90%)
// 6. Writing listen events  (90-100%)
const STAGES = [
  { pct: 5,   label: "Connecting to Spotify…" },
  { pct: 20,  label: "Fetching saved tracks…" },
  { pct: 35,  label: "Fetching top artists…" },
  { pct: 50,  label: "Fetching recent plays…" },
  { pct: 65,  label: "Saving artists…" },
  { pct: 80,  label: "Saving tracks…" },
  { pct: 90,  label: "Writing listen events…" },
  { pct: 95,  label: "Finishing up…" },
];

export default function SyncButton() {
  const [state, setState] = useState<SyncState>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [stageLabel, setStageLabel] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Simulated progress that advances through stages while the API is running
  function startProgress() {
    let stageIdx = 0;
    setProgress(0);
    setStageLabel(STAGES[0].label);

    intervalRef.current = setInterval(() => {
      stageIdx++;
      if (stageIdx < STAGES.length) {
        setProgress(STAGES[stageIdx].pct);
        setStageLabel(STAGES[stageIdx].label);
      }
    }, 3000); // advance every 3s — total ~24s for 8 stages, backend takes ~15-30s
  }

  function stopProgress(success: boolean) {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (success) {
      setProgress(100);
      setStageLabel("Done!");
    }
  }

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function handleSync() {
    setState("syncing");
    setMessage("");
    startProgress();

    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        stopProgress(true);
        setState("success");
        setMessage("Library synced!");
        // After success, start polling to detect when the background job completes
        pollForCompletion();
      } else {
        stopProgress(false);
        setState("error");
        setMessage(data.error ?? data.detail ?? "Unknown error");
      }
    } catch (err) {
      stopProgress(false);
      setState("error");
      setMessage(err instanceof Error ? err.message : "Network error");
    }
  }

  // The API returns immediately (queued). Poll the library to detect completion.
  async function pollForCompletion() {
    const maxPolls = 20;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch("/api/library");
        if (res.ok) {
          const data = await res.json();
          if (data.stats?.trackCount > 0) {
            setMessage(`Synced! ${data.stats.trackCount} tracks, ${data.stats.artistCount} artists`);
            setProgress(100);
            setStageLabel("Complete!");
            return;
          }
        }
      } catch {
        // ignore polling errors
      }
    }
  }

  return (
    <div className="space-y-1.5">
      <button
        onClick={handleSync}
        disabled={state === "syncing"}
        className="w-full px-2.5 py-1.5 rounded border border-neutral-200 bg-white text-xs text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed text-left"
      >
        {state === "syncing" ? "Syncing…" : "Sync Spotify library"}
      </button>

      {state === "syncing" && (
        <div className="space-y-1 px-0.5">
          <div className="w-full h-2 bg-neutral-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-[10px] text-neutral-500">{stageLabel}</p>
        </div>
      )}

      {state === "success" && (
        <div className="space-y-1 px-0.5">
          <div className="w-full h-2 bg-neutral-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-[11px] text-emerald-600">{message}</p>
        </div>
      )}

      {state === "error" && (
        <p className="text-[11px] text-red-500 px-0.5">{message}</p>
      )}
    </div>
  );
}
