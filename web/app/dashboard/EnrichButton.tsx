"use client";

import { useState } from "react";

type EnrichState = "idle" | "loading" | "success" | "error";

export default function EnrichButton() {
  const [state, setState] = useState<EnrichState>("idle");
  const [message, setMessage] = useState("");

  async function handleEnrich() {
    setState("loading");
    setMessage("");
    try {
      const res = await fetch("/api/enrich", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setState("success");
        setMessage("Queued");
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
    <div className="space-y-1">
      <button
        onClick={handleEnrich}
        disabled={state === "loading"}
        className="w-full px-2.5 py-1.5 rounded border border-neutral-200 bg-white text-xs text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed text-left"
      >
        {state === "loading" ? "Enriching…" : "Enrich artists"}
      </button>
      {state === "success" && (
        <p className="text-[11px] text-emerald-600 px-0.5">{message}</p>
      )}
      {state === "error" && (
        <p className="text-[11px] text-red-500 px-0.5">{message}</p>
      )}
    </div>
  );
}
