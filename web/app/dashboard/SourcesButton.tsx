"use client";

import { useJobPoller } from "./useJobPoller";

export default function SourcesButton() {
  const { state, message, trigger } = useJobPoller("/api/sources");

  return (
    <div className="space-y-1.5">
      <button
        onClick={trigger}
        disabled={state === "running"}
        className="w-full px-2.5 py-1.5 rounded border border-neutral-200 bg-white text-xs text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed text-left"
      >
        {state === "running" ? "Fetching…" : "Fetch sources"}
      </button>

      {state === "running" && (
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
