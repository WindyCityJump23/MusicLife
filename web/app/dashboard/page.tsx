"use client";

import { useEffect, useState } from "react";
import Sidebar, { type View } from "./sidebar";
import LibraryView from "./library-view";
import DiscoverView from "./discover-view";
import PlaylistsView from "./playlists-view";
import ActivityView from "./activity-view";
import SavedView from "./saved-view";
import Player from "./Player";
import { PlayerProvider } from "./player-context";

const TITLES: Record<View, string> = {
  library: "Library",
  discover: "Discover",
  playlists: "Playlists",
  activity: "Activity",
  saved: "Saved views",
};

export default function Dashboard() {
  const [view, setView] = useState<View>("library");
  const [navOpen, setNavOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);

  // Close drawers on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNavOpen(false);
        setPlayerOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Lock body scroll while a drawer is open on mobile
  useEffect(() => {
    if (typeof document === "undefined") return;
    const open = navOpen || playerOpen;
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [navOpen, playerOpen]);

  function handleNavChange(v: View) {
    setView(v);
    setNavOpen(false);
  }

  return (
    <PlayerProvider>
      <div className="lg:grid lg:grid-cols-[240px_1fr_360px] lg:h-screen text-neutral-900">
        {/* ── Mobile top bar ──────────────────────────────────── */}
        <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between gap-2 px-3 h-14 bg-white/95 backdrop-blur border-b border-neutral-200 pt-safe">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="w-10 h-10 -ml-1 rounded-lg flex items-center justify-center text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200 transition-colors"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>

          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base">🎶</span>
            <h1 className="text-sm font-semibold tracking-tight truncate">
              {TITLES[view]}
            </h1>
          </div>

          <button
            onClick={() => setPlayerOpen(true)}
            aria-label="Open player"
            className="w-10 h-10 -mr-1 rounded-lg flex items-center justify-center text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200 transition-colors"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        </header>

        {/* ── Sidebar (desktop column / mobile drawer) ─────────── */}
        <aside
          className={[
            // Desktop: static column
            "lg:relative lg:translate-x-0 lg:h-screen lg:w-auto lg:block",
            // Mobile: fixed drawer
            "fixed inset-y-0 left-0 z-50 w-[85%] max-w-[320px] bg-white shadow-xl lg:shadow-none",
            "transition-transform duration-200 ease-out lg:transition-none",
            navOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          ].join(" ")}
        >
          <Sidebar
            active={view}
            onChange={handleNavChange}
            onClose={() => setNavOpen(false)}
          />
        </aside>

        {/* ── Mobile sidebar backdrop ─────────────────────────── */}
        {navOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-neutral-900/40 z-40 animate-fade-in"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* ── Main content ────────────────────────────────────── */}
        <main className="lg:overflow-y-auto lg:h-screen min-h-[calc(100vh-3.5rem)] lg:min-h-0">
          <div className="px-4 sm:px-6 lg:px-8 py-4 lg:py-6 max-w-5xl pb-24 lg:pb-6">
            <header className="mb-4 lg:mb-6 hidden lg:block">
              <h2 className="text-lg font-semibold tracking-tight">{TITLES[view]}</h2>
            </header>
            {view === "library" && <LibraryView />}
            {view === "discover" && <DiscoverView onNavigate={(v) => setView(v as View)} />}
            {view === "playlists" && <PlaylistsView />}
            {view === "activity" && <ActivityView />}
            {view === "saved" && <SavedView />}
          </div>
        </main>

        {/* ── Player (desktop column / mobile sheet) ──────────── */}
        <aside
          className={[
            // Desktop: static right column
            "lg:relative lg:translate-y-0 lg:h-screen lg:overflow-y-auto lg:border-l lg:border-neutral-200 lg:block",
            // Mobile: fixed bottom sheet
            "fixed inset-x-0 bottom-0 top-14 z-50 overflow-y-auto",
            "transition-transform duration-200 ease-out lg:transition-none",
            playerOpen ? "translate-y-0" : "translate-y-full lg:translate-y-0",
          ].join(" ")}
          style={{ background: "linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)" }}
        >
          {/* Mobile sheet handle + close */}
          <div className="lg:hidden flex items-center justify-between px-4 pt-3">
            <div className="flex-1 flex justify-center">
              <span className="block w-10 h-1 rounded-full bg-white/25" />
            </div>
            <button
              onClick={() => setPlayerOpen(false)}
              aria-label="Close player"
              className="w-9 h-9 rounded-lg flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 transition-colors"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M6 18L18 6" />
              </svg>
            </button>
          </div>

          <div className="p-3 sm:p-4 pb-safe">
            <Player />
          </div>
        </aside>

        {/* ── Mobile player backdrop ─────────────────────────── */}
        {playerOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-neutral-900/40 z-40 animate-fade-in"
            onClick={() => setPlayerOpen(false)}
            aria-hidden="true"
          />
        )}
      </div>
    </PlayerProvider>
  );
}
