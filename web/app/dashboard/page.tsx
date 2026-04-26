"use client";

import { useState } from "react";
import Sidebar, { type View } from "./sidebar";
import LibraryView from "./library-view";
import DiscoverView from "./discover-view";
import ActivityView from "./activity-view";
import SavedView from "./saved-view";
import Player from "./Player";

const TITLES: Record<View, string> = {
  library: "Library",
  discover: "Discover",
  activity: "Activity",
  saved: "Saved views",
};

export default function Dashboard() {
  const [view, setView] = useState<View>("library");

  return (
    <div className="grid grid-cols-[240px_1fr_320px] h-screen text-neutral-900">
      <Sidebar active={view} onChange={setView} />

      <main className="overflow-y-auto">
        <div className="px-8 py-6 max-w-5xl">
          <header className="mb-6">
            <h2 className="text-lg font-semibold tracking-tight">{TITLES[view]}</h2>
          </header>
          {view === "library" && <LibraryView />}
          {view === "discover" && <DiscoverView />}
          {view === "activity" && <ActivityView />}
          {view === "saved" && <SavedView />}
        </div>
      </main>

      <aside className="border-l border-neutral-200 bg-neutral-50/40 overflow-y-auto">
        <div className="px-5 py-5 border-b border-neutral-200">
          <h3 className="text-sm font-semibold tracking-tight">Now playing</h3>
          <p className="text-xs text-neutral-500 mt-0.5">Spotify Web Playback</p>
        </div>
        <div className="p-5">
          <Player />
        </div>
      </aside>
    </div>
  );
}
