"use client";

import { useEffect, useRef, useState } from "react";

type State = "idle" | "loading" | "success" | "error";

export default function EmbedButton({ onComplete }: { onComplete?: () => void }) {
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  function startProgress() {
    setProgress(10);
    intervalRef.current = setInterval(() => {
      setProgress((p) => Math.min(p + 5, 90));
    }, 2000);
  }

  function stopProgress() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setProgress(100);
  }

  async function handleEmbed() {
    setState("loading");
    setMessage("Generating taste vectors…");
    startProgress();
    try {
      const res = await fetch("/api/embed", { method: "POST" });
      const data = await res.json();
      stopProgress();
      if (res.ok) {
        setState("success");
        setMessage("Embeddings queued — running in background");
        onComplete?.();
      } else {
        setState("error");
        setMessage(data.error ?? data.detail ?? "Unknown error");
      }
    } catch (err) {
      stopProgress();
      setState("error");
      setMessage(err instanceof Error ? err.message : "Network error");
    }
  }

  return (
    <div className="space-y-1.5">
      <button
        onClick={handleEmbed}
        disabled={state === "loading"}
        className="w-full px-2.5 py-1.5 rounded border border-neutral-200 bg-white text-xs text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed text-left"
      >
        {state === "loading" ? "Embedding…" : "Embed artists"}
      </button>
      {(state === "loading" || state === "success") && (
        <div className="space-y-1 px-0.5">
          <div className="w-full h-2 bg-neutral-100 rounded-full overflow-hidden">
            <div className="h-full bg-violet-500 rounded-full transition-all duration-700 ease-out" style={{ width: `${progress}%` }} />
          </div>
          <p className={`text-[10px] ${state === "success" ? "text-emerald-600" : "text-neutral-500"}`}>{message}</p>
        </div>
      )}
      {state === "error" && <p className="text-[11px] text-red-500 px-0.5">{message}</p>}
    </div>
  );
}
