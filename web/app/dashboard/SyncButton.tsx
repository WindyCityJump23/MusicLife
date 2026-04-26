"use client";

import { useState } from "react";

type SyncState = "idle" | "loading" | "success" | "error";

export default function SyncButton() {
  const [state, setState] = useState<SyncState>("idle");
  const [message, setMessage] = useState("");

  async function handleSync() {
    setState("loading");
    setMessage("");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setState("success");
        setMessage("Ingestion queued — check Supabase in a few seconds");
      } else {
        setState("error");
        setMessage(data.error ?? data.detail ?? "Unknown error");
      }
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Network error");
    }
  }

  return (
    <div className="space-y-3">
      <button
        onClick={handleSync}
        disabled={state === "loading"}
        className="px-4 py-2 rounded-md bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {state === "loading" ? "Syncing…" : "Sync my Spotify library"}
      </button>
      {state === "success" && (
        <p className="text-sm text-green-600">{message}</p>
      )}
      {state === "error" && (
        <p className="text-sm text-red-500">Error: {message}</p>
      )}
    </div>
  );
}
