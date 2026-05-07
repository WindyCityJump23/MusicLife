"use client";

import { useJobPoller } from "./useJobPoller";

export default function SourcesButton({
  disabled = false,
  onComplete,
}: {
  disabled?: boolean;
  onComplete?: () => void;
}) {
  const { state, message, trigger } = useJobPoller("/api/sources", onComplete);
  const isRunning = state === "running";

  return (
    <div className="space-y-1.5">
      <button
        onClick={trigger}
        disabled={disabled || isRunning}
        className="w-full px-3 py-2 rounded-md border border-amber-200 bg-amber-50 text-xs font-medium text-amber-800 hover:bg-amber-100 hover:border-amber-300 disabled:opacity-50 disabled:cursor-not-allowed text-left"
      >
        {isRunning ? "Refreshing sources…" : "Refresh discovery sources"}
      </button>

      <p className="text-[10px] text-neutral-500 leading-snug px-0.5">
        {disabled
          ? "Set up your music profile first so sources can match against your artists."
          : "Updates blogs, Reddit, and press mentions without rebuilding your full profile."}
      </p>

      {isRunning && (
        <div className="space-y-1 px-0.5">
          <div className="w-full h-2 bg-neutral-100 rounded-full overflow-hidden">
            <div className="h-full bg-amber-500 rounded-full animate-pulse" style={{ width: "100%" }} />
          </div>
          <p className="text-[10px] text-neutral-500">{message}</p>
        </div>
      )}

      {state === "success" && (
        <p className="text-[11px] text-emerald-600 px-0.5">✓ {message}</p>
      )}

      {state === "error" && (
        <p className="text-[11px] text-red-500 px-0.5">✗ {message}</p>
      )}
    </div>
  );
}
