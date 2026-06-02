"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function PlaylistImportForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || loading) return;

    setLoading(true);
    setError(null);
    setProgress("Importing playlist...");

    try {
      const res = await fetch("/api/import-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message ?? data.error ?? "Something went wrong.");
        setLoading(false);
        setProgress(null);
        return;
      }

      // Store job_id for dashboard to pick up setup progress
      if (data.job_id) {
        localStorage.setItem("musiclife.setupAll.jobId", data.job_id);
      }

      setProgress(
        `Imported ${data.track_count} tracks from ${data.artist_count} artists. Redirecting...`
      );

      // Short delay so user sees the success message
      setTimeout(() => router.push("/dashboard"), 800);
    } catch {
      setError("Network error. Please check your connection and try again.");
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={handleSubmit} className="space-y-2.5">
        <input
          type="text"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Paste a Spotify playlist link..."
          className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30 focus:bg-white/[0.07] transition"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={!url.trim() || loading}
          className="w-full rounded-full bg-emerald-500 text-white px-7 py-3 text-sm font-medium hover:bg-emerald-400 active:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {loading ? "Importing..." : "Start with this playlist"}
        </button>
      </form>

      {error && (
        <div className="rounded-xl border border-red-400/30 bg-red-900/30 px-4 py-2.5 text-xs text-red-300 text-left">
          {error}
        </div>
      )}

      {progress && !error && (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-900/30 px-4 py-2.5 text-xs text-emerald-300 text-left">
          {progress}
        </div>
      )}

      <p className="text-xs text-white/45 leading-relaxed max-w-xs mx-auto">
        No Spotify login needed. Paste any public playlist to get personalized
        Radio picks.
      </p>
    </div>
  );
}
