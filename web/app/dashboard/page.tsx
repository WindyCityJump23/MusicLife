"use client";

import { useState } from "react";
import Sidebar, { type View } from "./sidebar";
import LibraryView from "./library-view";
import DiscoverView from "./discover-view";
import ActivityView from "./activity-view";

const TITLES: Record<View, string> = {
  library: "Library",
  discover: "Discover",
  activity: "Activity",
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
        </div>
      </main>

      <aside className="border-l border-neutral-200 bg-neutral-50/40 overflow-y-auto">
        <div className="px-5 py-5 border-b border-neutral-200">
          <h3 className="text-sm font-semibold tracking-tight">Now playing</h3>
          <p className="text-xs text-neutral-500 mt-0.5">Why this surfaced</p>
        </div>
        <div className="p-5">
          <div className="border border-dashed border-neutral-300 rounded-md p-6 text-center text-xs text-neutral-500">
            Select a track to see why it surfaced.
          </div>
        </div>
      </aside>
    </div>
  );
}
