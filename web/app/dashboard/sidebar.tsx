"use client";

import SyncButton from "./SyncButton";
import EnrichButton from "./EnrichButton";
import EmbedButton from "./EmbedButton";
import SourcesButton from "./SourcesButton";

export type View = "library" | "discover" | "activity";

const NAV: { id: View; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "discover", label: "Discover" },
  { id: "activity", label: "Activity" },
];

export default function Sidebar({
  active,
  onChange,
}: {
  active: View;
  onChange: (v: View) => void;
}) {
  return (
    <aside className="flex flex-col h-full border-r border-neutral-200 bg-neutral-50/40">
      <div className="px-4 py-5 border-b border-neutral-200">
        <h1 className="text-sm font-semibold tracking-tight">Music Dashboard</h1>
      </div>

      <nav className="flex-1 p-2 space-y-0.5">
        {NAV.map((item) => {
          const isActive = item.id === active;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={[
                "w-full text-left px-3 py-1.5 rounded text-sm transition-colors",
                isActive
                  ? "bg-emerald-50 text-emerald-700 font-medium"
                  : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
              ].join(" ")}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-neutral-200 p-3 space-y-2">
        <p className="text-[11px] uppercase tracking-wide text-neutral-400 px-0.5">
          Sync
        </p>
        <SyncButton />
        <EnrichButton />
        <EmbedButton />
        <SourcesButton />
      </div>
    </aside>
  );
}
