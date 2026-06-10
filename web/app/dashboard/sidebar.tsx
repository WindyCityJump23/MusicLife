"use client";

import { useEffect, useState } from "react";
import SetupAllButton from "./SetupAllButton";
import SourcesButton from "./SourcesButton";
import { useAuth } from "./auth-context";
import { useReadiness } from "./readiness-context";
import { completedStepNumbers } from "@/lib/readiness";

export type View = "discover" | "playlists" | "library" | "activity";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "discover",   label: "Radio",         icon: "▶" },
  { id: "playlists",  label: "Playlists",     icon: "▦" },
  { id: "library",    label: "Taste Profile", icon: "◎" },
  { id: "activity",   label: "History",       icon: "◷" },
];

const STEP_META_SPOTIFY = [
  { step: 1, title: "Import listening history", desc: "Bring in your Spotify artists and recent plays" },
  { step: 2, title: "Learn your taste",         desc: "Add genre and artist context" },
  { step: 3, title: "Connect your taste",        desc: "Prepare matching signals for better stations" },
  { step: 4, title: "Add music context",        desc: "Blend in editorial sources and buzz" },
  { step: 5, title: "Prepare playable songs",   desc: "Load songs for radio and playlists" },
  { step: 6, title: "Refine discovery",         desc: "Improve song-level matching for fresher stations" },
];

const STEP_META_GUEST = [
  { step: 1, title: "Import playlist",          desc: "Tracks imported from your playlist" },
  { step: 2, title: "Learn your taste",         desc: "Add genre and artist context" },
  { step: 3, title: "Connect your taste",        desc: "Prepare matching signals for better stations" },
  { step: 4, title: "Add music context",        desc: "Blend in editorial sources and buzz" },
  { step: 5, title: "Prepare playable songs",   desc: "Load songs for recommendations" },
  { step: 6, title: "Refine discovery",         desc: "Improve song-level matching for fresher stations" },
];

// Guest users only see Radio and Taste Profile
const GUEST_NAV_IDS = new Set<View>(["discover", "library"]);

export default function Sidebar({
  active,
  onChange,
  onClose,
  onSetupComplete,
}: {
  active: View;
  onChange: (v: View) => void;
  onClose?: () => void;
  onSetupComplete?: () => void;
}) {
  const { isGuest } = useAuth();
  const stepMeta = isGuest ? STEP_META_GUEST : STEP_META_SPOTIFY;
  const navItems = isGuest ? NAV.filter((n) => GUEST_NAV_IDS.has(n.id)) : NAV;

  const { data: readinessData, refresh } = useReadiness();
  const [displayName,    setDisplayName]    = useState<string | null>(null);

  const completedSteps = completedStepNumbers(readinessData?.readiness?.steps);
  const catalogStats =
    readinessData?.catalogStats &&
    typeof readinessData.catalogStats.library === "number" &&
    typeof readinessData.catalogStats.discovered === "number" &&
    typeof readinessData.catalogStats.embedded === "number"
      ? readinessData.catalogStats
      : null;
  const allDone = completedSteps.size >= stepMeta.length;
  const [setupOpen,      setSetupOpen]      = useState(!allDone);
  const setupStatusLabel = allDone ? "Ready" : completedSteps.size > 0 ? "In progress" : "Needs setup";
  const setupStatusClass = allDone
    ? "bg-emerald-50 text-emerald-700 border-emerald-100"
    : completedSteps.size > 0
      ? "bg-amber-50 text-amber-700 border-amber-100"
      : "bg-neutral-100 text-neutral-600 border-neutral-200";

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

  // Completed steps + catalog stats now come from the shared ReadinessProvider
  // (single poller). Force an immediate re-check after a setup step completes.
  function checkLibraryStatus() {
    void refresh();
  }

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
        {navItems.map((item) => {
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
          className="w-full flex items-start justify-between gap-2 px-1 pt-1 pb-2 group text-left"
          aria-expanded={setupOpen}
        >
          <span className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-medium">
              Music Profile
            </p>
            <p className="mt-1 text-xs text-neutral-500 leading-snug">
              {allDone
                ? isGuest
                  ? "Ready for recommendations. Import another playlist to update your taste."
                  : "Ready for radio and playlists. Refresh only when your Spotify taste changes."
                : "One setup run teaches MusicLife what to recommend."}
            </p>
          </span>
          <span className="flex items-center gap-1.5 pt-0.5">
            <span className={[
              "rounded-full border px-2 py-0.5 text-[10px] font-medium",
              setupStatusClass,
            ].join(" ")}>
              {setupStatusLabel}
            </span>
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
          </span>
        </button>

        {setupOpen && <div className="space-y-3">

        {catalogStats && (
          <p
            className="px-1 -mt-1 text-[10px] text-neutral-500 leading-snug"
            title="Refresh your profile to add more discovery matches"
          >
            Songs: {catalogStats.library.toLocaleString()} saved,{" "}
            {catalogStats.discovered.toLocaleString()} ready for discovery
          </p>
        )}

        <SetupAllButton
          isReady={allDone}
          onProgress={checkLibraryStatus}
          onComplete={onSetupComplete}
        />

        <SourcesButton
          disabled={!completedSteps.has(1)}
          onComplete={checkLibraryStatus}
        />

        <div className="space-y-2 pt-1">
          {stepMeta.map((s) => (
            <StepItem
              key={s.step}
              step={s.step}
              title={s.title}
              desc={s.desc}
              done={completedSteps.has(s.step)}
            />
          ))}
        </div>
        </div>}
      </div>

      {/* ── Guest upgrade CTA ──────────────────────────────── */}
      {isGuest && (
        <div className="px-3 pb-2">
          <a
            href="/api/auth/login?force=1"
            className="block w-full px-3 py-2.5 rounded-lg bg-emerald-50 border border-emerald-100 text-xs text-emerald-700 font-medium hover:bg-emerald-100 active:bg-emerald-200 transition-colors text-center"
          >
            🔗 Connect Spotify for full features
          </a>
          <p className="text-[10px] text-neutral-400 mt-1.5 px-1 leading-snug">
            Unlock in-app playback, playlists, and library sync.
          </p>
        </div>
      )}

      {/* ── Sign out ─────────────────────────────────────────── */}
      <div className="px-3 pb-4 pb-safe border-t border-neutral-200 pt-3">
        <button
          onClick={handleLogout}
          className="w-full px-2.5 py-2 rounded-lg border border-neutral-200 bg-white text-xs text-neutral-500 hover:bg-neutral-50 hover:border-neutral-300 active:bg-neutral-100 text-left"
        >
          {isGuest ? "↩ Start over" : "↩ Sign out"}
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
}: {
  step: number;
  title: string;
  desc: string;
  done: boolean;
}) {
  return (
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
  );
}
