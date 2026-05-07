"use client";

import { useEffect, useState } from "react";
import SetupAllButton from "./SetupAllButton";
import SourcesButton from "./SourcesButton";

export type View = "discover" | "playlists" | "library" | "activity";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "discover",   label: "Radio",         icon: "▶" },
  { id: "playlists",  label: "Playlists",     icon: "▦" },
  { id: "library",    label: "Taste Profile", icon: "◎" },
  { id: "activity",   label: "History",       icon: "◷" },
];

const STEP_META = [
  { step: 1, title: "Import listening history", desc: "Bring in your Spotify artists and recent plays" },
  { step: 2, title: "Learn your taste",         desc: "Add genre and artist context" },
  { step: 3, title: "Build your radio model",   desc: "Prepare matching signals for better stations" },
  { step: 4, title: "Add music context",        desc: "Blend in editorial sources and buzz" },
  { step: 5, title: "Prepare song catalog",     desc: "Load playable tracks for radio and playlists" },
];

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
  const [displayName,    setDisplayName]    = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [catalogStats,   setCatalogStats]   = useState<{
    library: number;
    discovered: number;
    embedded: number;
  } | null>(null);
  const allDone = completedSteps.size >= 5;
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

  // ── Derive completed steps from library state ────────────────
  function checkLibraryStatus() {
    fetch("/api/readiness")
      .then((r) => r.json())
      .then((data) => {
        const done = new Set<number>();
        const steps = data.readiness?.steps;
        if (steps?.imported) done.add(1);
        if (steps?.enriched) done.add(2);
        if (steps?.embedded) done.add(3);
        if (steps?.context) done.add(4);
        if (steps?.tracks) done.add(5);
        setCompletedSteps(done);

        const catalog = data.catalogStats;
        if (
          typeof catalog?.library === "number" &&
          typeof catalog?.discovered === "number" &&
          typeof catalog?.embedded === "number"
        ) {
          setCatalogStats({
            library: catalog.library,
            discovered: catalog.discovered,
            embedded: catalog.embedded,
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
          className="w-full flex items-start justify-between gap-2 px-1 pt-1 pb-2 group text-left"
          aria-expanded={setupOpen}
        >
          <span className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-medium">
              Music Profile
            </p>
            <p className="mt-1 text-xs text-neutral-500 leading-snug">
              {allDone
                ? "Ready for radio and playlists. Refresh only when your Spotify taste changes."
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
          {STEP_META.map((s) => (
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
