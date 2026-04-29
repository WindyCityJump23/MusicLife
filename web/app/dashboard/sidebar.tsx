"use client";

import { useEffect, useState } from "react";
import SyncButton from "./SyncButton";
import EnrichButton from "./EnrichButton";
import EmbedButton from "./EmbedButton";
import SourcesButton from "./SourcesButton";
import PopulateTracksButton from "./PopulateTracksButton";

export type View = "library" | "discover" | "playlists" | "activity" | "saved";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "library",    label: "Library",    icon: "🎵" },
  { id: "discover",   label: "Discover",   icon: "🔍" },
  { id: "playlists",  label: "Playlists",  icon: "📀" },
  { id: "activity",   label: "Activity",   icon: "📊" },
  { id: "saved",      label: "Saved",      icon: "💾" },
];

const STEP_META = [
  { step: 1, title: "Sync Library",    desc: "Import your Spotify artists & listening history" },
  { step: 2, title: "Enrich Artists",  desc: "Fetch genres, tags & metadata for each artist" },
  { step: 3, title: "Generate Embeddings", desc: "Build AI taste vectors for smart matching" },
  { step: 4, title: "Sync Sources",    desc: "Add editorial content (blogs, charts, reviews)" },
  { step: 5, title: "Populate Tracks", desc: "Fetch songs for all artists to power Discover" },
];

export default function Sidebar({
  active,
  onChange,
  onClose,
}: {
  active: View;
  onChange: (v: View) => void;
  onClose?: () => void;
}) {
  const [displayName,    setDisplayName]    = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [catalogStats,   setCatalogStats]   = useState<{
    library: number;
    discovered: number;
    embedded: number;
  } | null>(null);
  const allDone = completedSteps.size >= 5;
  const [setupOpen,      setSetupOpen]      = useState(!allDone);

  // Auto-collapse when all steps complete
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (allDone) setSetupOpen(false); }, [allDone]);

  // ── Fetch user display name ──────────────────────────────────
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => { if (d.displayName) setDisplayName(d.displayName); })
      .catch(() => {});
  }, []);

  // ── Derive completed steps from library state ────────────────
  function checkLibraryStatus() {
    fetch("/api/library")
      .then((r) => r.json())
      .then((data) => {
        const artists: Array<{ enriched: boolean; embedded: boolean }> =
          data.artists ?? [];
        const done = new Set<number>();
        if (artists.length > 0)                          done.add(1);
        if (artists.some((a) => a.enriched))             done.add(2);
        if (artists.some((a) => a.embedded))             done.add(3);
        if ((data.stats?.mentionCount ?? 0) > 0)         done.add(4);
        if ((data.stats?.catalogTrackCount ?? 0) > artists.length * 2) done.add(5);
        setCompletedSteps(done);
      })
      .catch(() => {});

    fetch("/api/catalog/stats")
      .then((r) => r.json())
      .then((data) => {
        if (
          typeof data?.library === "number" &&
          typeof data?.discovered === "number" &&
          typeof data?.embedded === "number"
        ) {
          setCatalogStats({
            library: data.library,
            discovered: data.discovered,
            embedded: data.embedded,
          });
        }
      })
      .catch(() => {});
  }

  // Check on mount then poll every 30 s so steps tick off automatically
  // as background jobs complete — no page reload required.
  useEffect(() => {
    checkLibraryStatus();
    const id = setInterval(checkLibraryStatus, 30_000);
    return () => clearInterval(id);
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  return (
    <div className="flex flex-col h-full lg:h-screen border-r border-neutral-200 bg-neutral-50/40 overflow-y-auto pt-safe">
      {/* ── Brand header ────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2 px-4 py-4 lg:py-5 border-b border-neutral-200">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight">🎶 MusicLife</h1>
          {displayName && (
            <p className="text-xs text-neutral-500 mt-0.5 truncate">{displayName}</p>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="lg:hidden w-9 h-9 -mr-2 -mt-1 rounded-lg flex items-center justify-center text-neutral-500 hover:bg-neutral-100 active:bg-neutral-200 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
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
                "w-full text-left px-3 py-2.5 lg:py-2 rounded-lg text-sm transition-colors flex items-center gap-2.5 min-h-[44px] lg:min-h-0",
                isActive
                  ? "bg-emerald-50 text-emerald-700 font-medium"
                  : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 active:bg-neutral-200",
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
      <div className="px-3 pb-3 flex-1">
        <button
          onClick={() => setSetupOpen(!setupOpen)}
          className="w-full flex items-center justify-between px-1 pt-1 pb-2 group"
          aria-expanded={setupOpen}
        >
          <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-medium">
            Setup Your Library
          </p>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={[
              "text-neutral-400 transition-transform duration-200",
              setupOpen ? "rotate-180" : "",
            ].join(" ")}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {setupOpen && <div className="space-y-3">

        {catalogStats && (
          <p
            className="px-1 -mt-1 text-[10px] text-neutral-500 leading-snug"
            title="Run Enrich + Embed again to grow the discovered catalog"
          >
            Catalog: {catalogStats.library.toLocaleString()} library,{" "}
            {catalogStats.discovered.toLocaleString()} discovered
            {catalogStats.embedded > 0 && (
              <>
                {" "}
                <span className="text-neutral-400">
                  ({catalogStats.embedded.toLocaleString()} embedded)
                </span>
              </>
            )}
          </p>
        )}

        <StepItem
          step={1}
          title={STEP_META[0].title}
          desc={STEP_META[0].desc}
          done={completedSteps.has(1)}
        >
          <SyncButton onComplete={checkLibraryStatus} />
        </StepItem>

        <StepItem
          step={2}
          title={STEP_META[1].title}
          desc={STEP_META[1].desc}
          done={completedSteps.has(2)}
        >
          <EnrichButton onComplete={checkLibraryStatus} />
        </StepItem>

        <StepItem
          step={3}
          title={STEP_META[2].title}
          desc={STEP_META[2].desc}
          done={completedSteps.has(3)}
        >
          <EmbedButton onComplete={checkLibraryStatus} />
        </StepItem>

        <StepItem
          step={4}
          title={STEP_META[3].title}
          desc={STEP_META[3].desc}
          done={completedSteps.has(4)}
        >
          <SourcesButton onComplete={checkLibraryStatus} />
        </StepItem>

        <StepItem
          step={5}
          title={STEP_META[4].title}
          desc={STEP_META[4].desc}
          done={completedSteps.has(5)}
        >
          <PopulateTracksButton onComplete={checkLibraryStatus} />
        </StepItem>
        </div>}
      </div>

      {/* ── Sign out ─────────────────────────────────────────── */}
      <div className="px-3 pb-4 pb-safe border-t border-neutral-200 pt-3">
        <button
          onClick={handleLogout}
          className="w-full px-2.5 py-2 rounded-lg border border-neutral-200 bg-white text-xs text-neutral-500 hover:bg-neutral-50 hover:border-neutral-300 active:bg-neutral-100 text-left"
        >
          ↩ Sign out
        </button>
      </div>
    </div>
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
