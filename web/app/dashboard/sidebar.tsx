"use client";

import { useEffect, useState } from "react";
import SyncButton from "./SyncButton";
import EnrichButton from "./EnrichButton";
import EmbedButton from "./EmbedButton";
import SourcesButton from "./SourcesButton";

export type View = "library" | "discover" | "activity" | "saved";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "library",  label: "Library",  icon: "🎵" },
  { id: "discover", label: "Discover", icon: "🔍" },
  { id: "activity", label: "Activity", icon: "📊" },
  { id: "saved",    label: "Saved",    icon: "💾" },
];

const STEP_META = [
  { step: 1, title: "Sync Library",    desc: "Import your Spotify artists & listening history" },
  { step: 2, title: "Enrich Artists",  desc: "Fetch genres, tags & metadata for each artist" },
  { step: 3, title: "Generate Embeddings", desc: "Build AI taste vectors for smart matching" },
  { step: 4, title: "Sync Sources",    desc: "Add editorial content (blogs, charts, reviews)" },
];

export default function Sidebar({
  active,
  onChange,
}: {
  active: View;
  onChange: (v: View) => void;
}) {
  const [displayName,    setDisplayName]    = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());

  // ── Fetch user display name ──────────────────────────────────
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => { if (d.displayName) setDisplayName(d.displayName); })
      .catch(() => {});
  }, []);

  // ── Derive completed steps from library state ────────────────
  useEffect(() => {
    fetch("/api/library")
      .then((r) => r.json())
      .then((data) => {
        const artists: Array<{ enriched: boolean; embedded: boolean }> =
          data.artists ?? [];
        const done = new Set<number>();
        if (artists.length > 0)                          done.add(1);
        if (artists.some((a) => a.enriched))             done.add(2);
        if (artists.some((a) => a.embedded))             done.add(3);
        // Step 4 (sources) is harder to detect; mark done if steps 1-3 done and
        // there's a hint in the payload — for now leave it user-driven.
        setCompletedSteps(done);
      })
      .catch(() => {});
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  return (
    <aside className="flex flex-col h-full border-r border-neutral-200 bg-neutral-50/40 overflow-y-auto">
      {/* ── Brand header ────────────────────────────────────── */}
      <div className="px-4 py-5 border-b border-neutral-200">
        <h1 className="text-sm font-semibold tracking-tight">🎶 MusicLife</h1>
        {displayName && (
          <p className="text-xs text-neutral-500 mt-0.5 truncate">{displayName}</p>
        )}
      </div>

      {/* ── Navigation ─────────────────────────────────────── */}
      <nav className="p-2 space-y-0.5">
        {NAV.map((item) => {
          const isActive = item.id === active;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={[
                "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2.5",
                isActive
                  ? "bg-emerald-50 text-emerald-700 font-medium"
                  : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
              ].join(" ")}
            >
              <span className="text-base leading-none w-5 text-center">{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* ── Divider ─────────────────────────────────────────── */}
      <div className="mx-3 my-2 border-t border-neutral-200" />

      {/* ── Setup steps ─────────────────────────────────────── */}
      <div className="px-3 pb-3 space-y-3 flex-1">
        <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-medium px-1 pt-1">
          Setup Your Library
        </p>

        <StepItem
          step={1}
          title={STEP_META[0].title}
          desc={STEP_META[0].desc}
          done={completedSteps.has(1)}
        >
          <SyncButton />
        </StepItem>

        <StepItem
          step={2}
          title={STEP_META[1].title}
          desc={STEP_META[1].desc}
          done={completedSteps.has(2)}
        >
          <EnrichButton />
        </StepItem>

        <StepItem
          step={3}
          title={STEP_META[2].title}
          desc={STEP_META[2].desc}
          done={completedSteps.has(3)}
        >
          <EmbedButton />
        </StepItem>

        <StepItem
          step={4}
          title={STEP_META[3].title}
          desc={STEP_META[3].desc}
          done={completedSteps.has(4)}
        >
          <SourcesButton />
        </StepItem>
      </div>

      {/* ── Sign out ─────────────────────────────────────────── */}
      <div className="px-3 pb-4 border-t border-neutral-200 pt-3">
        <button
          onClick={handleLogout}
          className="w-full px-2.5 py-1.5 rounded-lg border border-neutral-200 bg-white text-xs text-neutral-500 hover:bg-neutral-50 hover:border-neutral-300 text-left"
        >
          ↩ Sign out
        </button>
      </div>
    </aside>
  );
}

// ── Step wrapper component ────────────────────────────────────────

function StepItem({
  step,
  title,
  desc,
  done,
  children,
}: {
  step: number;
  title: string;
  desc: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {/* Step label row */}
      <div className="flex items-start gap-2">
        <div
          className={[
            "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5 transition-colors",
            done
              ? "bg-emerald-500 text-white"
              : "bg-neutral-200 text-neutral-500",
          ].join(" ")}
        >
          {done ? "✓" : step}
        </div>
        <div>
          <div className="text-xs font-medium text-neutral-800 leading-tight">{title}</div>
          <div className="text-[10px] text-neutral-400 leading-snug mt-0.5">{desc}</div>
        </div>
      </div>
      {/* Button */}
      <div className="pl-7">{children}</div>
    </div>
  );
}
