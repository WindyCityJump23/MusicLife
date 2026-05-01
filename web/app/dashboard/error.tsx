"use client";

import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard error]", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-5">
      <div className="max-w-sm w-full text-center space-y-4">
        <div className="text-4xl">⚠️</div>
        <div>
          <h2 className="text-base font-semibold text-neutral-900">
            Something went wrong
          </h2>
          <p className="text-sm text-neutral-500 mt-1 leading-relaxed">
            {error.message || "An unexpected error occurred."}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={reset}
            className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-colors"
          >
            Try again
          </button>
          <a
            href="/dashboard"
            className="px-4 py-2 rounded-lg border border-neutral-200 text-sm text-neutral-600 hover:bg-neutral-50 transition-colors"
          >
            Reload dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
