"use client";

import { useEffect, useState } from "react";
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

// Guest users only see Radio and Taste Profile
const GUEST_NAV_IDS = new Set<View>(["discover", "library"]);

const TOTAL_SETUP_STEPS = 6;

export default function Sidebar({
  active,
  onChange,
  onClose,
}: {
  active: View;
  onChange: (v: View) => void;
  onClose?: () => void;
}) {
  const { isGuest } = useAuth();
  const navItems = isGuest ? NAV.filter((n) => GUEST_NAV_IDS.has(n.id)) : NAV;

  const { data: readinessData, refresh } = useReadiness();
  const [displayName,    setDisplayName]    = useState<string | null>(null);

  const completedSteps = completedStepNumbers(readinessData?.readiness?.steps);
  const allDone = completedSteps.size >= TOTAL_SETUP_STEPS;
  const setupStatusLabel = allDone ? "Ready" : completedSteps.size > 0 ? "In progress" : "Setting up";
  const setupStatusClass = allDone
    ? "bg-emerald-50 text-emerald-700 border-emerald-100"
    : "bg-amber-50 text-amber-700 border-amber-100";

  // ── Fetch user display name ──────────────────────────────────
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => { if (d.displayName) setDisplayName(d.displayName); })
      .catch(() => {});
  }, []);

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

      {/* ── Station status (passive — setup lives on the Radio tab) ── */}
      <div className="px-3 pb-3 flex-1">
        {!allDone && (
          <button
            onClick={() => onChange("discover")}
            className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border border-neutral-200 bg-white text-left hover:bg-neutral-50 transition-colors"
          >
            <span className="text-xs text-neutral-600">Station setup</span>
            <span
              className={[
                "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                setupStatusClass,
              ].join(" ")}
            >
              {setupStatusLabel}
            </span>
          </button>
        )}

        {/* Maintenance: only relevant once the library is imported. */}
        {allDone && (
          <div className="space-y-1.5">
            <p className="px-1 text-[10px] uppercase tracking-widest text-neutral-400 font-medium">
              Keep it fresh
            </p>
            <SourcesButton
              disabled={!completedSteps.has(1)}
              onComplete={checkLibraryStatus}
            />
          </div>
        )}
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

