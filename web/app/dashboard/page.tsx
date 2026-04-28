"use client";

import { useState } from "react";
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

  return (
    <PlayerProvider>
      <div className="grid grid-cols-[240px_1fr_360px] h-screen text-neutral-900">
        <Sidebar active={view} onChange={setView} />

        <main className="overflow-y-auto">
          <div className="px-8 py-6 max-w-5xl">
            <header className="mb-6">
              <h2 className="text-lg font-semibold tracking-tight">{TITLES[view]}</h2>
            </header>
            {view === "library" && <LibraryView />}
            {view === "discover" && <DiscoverView onNavigate={(v) => setView(v as View)} />}
            {view === "playlists" && <PlaylistsView />}
            {view === "activity" && <ActivityView />}
            {view === "saved" && <SavedView />}
          </div>
        </main>

        <aside className="border-l border-neutral-200 overflow-y-auto" style={{ background: "linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)" }}>
          <div className="p-4">
            <Player />
          </div>
        </aside>
      </div>
    </PlayerProvider>
  );
}
