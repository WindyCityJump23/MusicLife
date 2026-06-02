"use client";

import { useEffect, useMemo, useState } from "react";
import { useJobPoller, type JobState } from "./useJobPoller";

type PublisherKind = "rss" | "reddit";

type Publisher = {
  name: string;
  kind: PublisherKind;
  url: string;
  trust: number;
};

const PUBLISHERS: Publisher[] = [
  { name: "Resident Advisor", kind: "rss", url: "https://ra.co/xml/rss.xml", trust: 0.9 },
  { name: "Stereogum", kind: "rss", url: "https://www.stereogum.com/feed/", trust: 0.82 },
  { name: "Pitchfork News", kind: "rss", url: "https://pitchfork.com/feed/feed-news/rss", trust: 0.83 },
  { name: "Bandcamp Daily", kind: "rss", url: "https://daily.bandcamp.com/feed", trust: 0.86 },
  { name: "Consequence", kind: "rss", url: "https://consequence.net/feed/", trust: 0.78 },
  { name: "NME", kind: "rss", url: "https://www.nme.com/feed", trust: 0.75 },
  { name: "FADER", kind: "rss", url: "https://www.thefader.com/feed", trust: 0.8 },
  { name: "Brooklyn Vegan", kind: "rss", url: "https://www.brooklynvegan.com/feed/", trust: 0.74 },
  { name: "The Line of Best Fit", kind: "rss", url: "https://www.thelineofbestfit.com/feed", trust: 0.76 },
  { name: "Hype Machine", kind: "rss", url: "https://hypem.com/popular/rss", trust: 0.84 },
  { name: "KEXP", kind: "rss", url: "https://www.kexp.org/feed/", trust: 0.81 },
  { name: "Paste Music", kind: "rss", url: "https://www.pastemagazine.com/music/feed/", trust: 0.76 },
  { name: "DIY Magazine", kind: "rss", url: "https://diymag.com/feed", trust: 0.75 },
  { name: "Under the Radar", kind: "rss", url: "https://www.undertheradarmag.com/news/rss/", trust: 0.76 },
  { name: "Exclaim", kind: "rss", url: "https://exclaim.ca/music/rss", trust: 0.75 },
  { name: "Gorilla vs Bear", kind: "rss", url: "https://www.gorillavsbear.net/feed/", trust: 0.78 },
  { name: "Hype Machine Latest", kind: "rss", url: "https://hypem.com/latest/rss", trust: 0.8 },
  { name: "Pigeons & Planes", kind: "rss", url: "https://pigeonsandplanes.com/feed/", trust: 0.77 },
  { name: "r/indieheads", kind: "reddit", url: "https://www.reddit.com/r/indieheads/.rss", trust: 0.65 },
  { name: "r/electronicmusic", kind: "reddit", url: "https://www.reddit.com/r/electronicmusic/.rss", trust: 0.63 },
  { name: "r/hiphopheads", kind: "reddit", url: "https://www.reddit.com/r/hiphopheads/.rss", trust: 0.64 },
  { name: "r/listentothis", kind: "reddit", url: "https://www.reddit.com/r/listentothis/.rss", trust: 0.7 },
  { name: "r/popheads", kind: "reddit", url: "https://www.reddit.com/r/popheads/.rss", trust: 0.62 },
  { name: "r/rnb", kind: "reddit", url: "https://www.reddit.com/r/rnb/.rss", trust: 0.61 },
  { name: "r/Music", kind: "reddit", url: "https://www.reddit.com/r/Music/.rss", trust: 0.55 },
  { name: "r/jazz", kind: "reddit", url: "https://www.reddit.com/r/jazz/.rss", trust: 0.6 },
  { name: "r/metal", kind: "reddit", url: "https://www.reddit.com/r/metal/.rss", trust: 0.6 },
  { name: "r/classicalmusic", kind: "reddit", url: "https://www.reddit.com/r/classicalmusic/.rss", trust: 0.58 },
  { name: "r/indiefolk", kind: "reddit", url: "https://www.reddit.com/r/indiefolk/.rss", trust: 0.64 },
  { name: "r/newmusic", kind: "reddit", url: "https://www.reddit.com/r/newmusic/.rss", trust: 0.67 },
];

const SOURCE_COUNT = PUBLISHERS.length;
const STAGES = [
  { id: "queued", label: "Queued" },
  { id: "feeds", label: "Feeds" },
  { id: "mentions", label: "Finding picks" },
  { id: "embedding", label: "Matching" },
  { id: "done", label: "Done" },
] as const;

type StageId = (typeof STAGES)[number]["id"];

function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function logoUrl(url: string): string {
  const domain = sourceDomain(url);
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : "";
}

function parseSourceProgress(message: string): { current: number; total: number } | null {
  const match = message.match(/\((\d+)\/(\d+)\)/);
  if (!match) return null;
  return { current: Number(match[1]), total: Number(match[2]) };
}

function activeStage(state: JobState, message: string): StageId {
  const lower = message.toLowerCase();
  const progress = parseSourceProgress(message);

  if (state === "success") return "done";
  if (lower.includes("embedding")) return "embedding";
  if (lower.includes("queued") || lower.includes("starting")) return "queued";
  if (progress && progress.total > 0 && progress.current / progress.total > 0.45) {
    return "mentions";
  }
  if (lower.includes("mention")) return "mentions";
  if (state === "running") return "feeds";
  return "queued";
}

function stageIndex(id: StageId): number {
  return STAGES.findIndex((stage) => stage.id === id);
}

function progressPercent(state: JobState, message: string): number {
  if (state === "success") return 100;
  const progress = parseSourceProgress(message);
  if (message.toLowerCase().includes("embedding")) return 92;
  if (progress && progress.total > 0) {
    return Math.max(8, Math.round((progress.current / progress.total) * 86));
  }
  if (state === "running") return 12;
  return 0;
}

function userFacingSourceMessage(state: JobState, message: string): string {
  const lower = message.toLowerCase();
  const progress = parseSourceProgress(message);

  if (state === "success") return "Discovery context refreshed.";
  if (state === "error") return "Could not refresh discovery context. Please try again.";
  if (lower.includes("embedding") || lower.includes("finalizing")) {
    return "Connecting fresh picks to your taste…";
  }
  if (progress) return `Reading music sources (${progress.current}/${progress.total})…`;
  if (lower.includes("queued") || lower.includes("starting")) return "Queuing source refresh…";
  if (state === "running") return "Refreshing discovery context…";
  return "";
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function SourceLogo({ publisher }: { publisher: Publisher }) {
  const [hidden, setHidden] = useState(false);
  const initials = publisher.name
    .replace(/^r\//, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <div
      className="group relative shrink-0"
      title={`${publisher.name} (${sourceDomain(publisher.url)})`}
    >
      <div className="w-8 h-8 rounded-md border border-neutral-200 bg-white flex items-center justify-center overflow-hidden shadow-sm">
        {!hidden && logoUrl(publisher.url) ? (
          <img
            src={logoUrl(publisher.url)}
            alt=""
            className="w-5 h-5 object-contain"
            onError={() => setHidden(true)}
          />
        ) : (
          <span className="text-[10px] font-semibold text-neutral-500">{initials}</span>
        )}
      </div>
      {publisher.kind === "reddit" && (
        <span className="absolute -right-0.5 -bottom-0.5 w-3 h-3 rounded-full bg-orange-500 border-2 border-white" />
      )}
    </div>
  );
}

function StageRail({
  state,
  message,
}: {
  state: JobState;
  message: string;
}) {
  const current = activeStage(state, message);
  const currentIndex = stageIndex(current);

  return (
    <div className="grid grid-cols-5 gap-1.5">
      {STAGES.map((stage, index) => {
        const done = index < currentIndex || state === "success";
        const active = index === currentIndex && state === "running";
        return (
          <div key={stage.id} className="space-y-1">
            <div
              className={[
                "h-1.5 rounded-full transition-colors",
                done || active
                  ? "bg-emerald-500"
                  : "bg-neutral-200",
              ].join(" ")}
            />
            <p
              className={[
                "text-[9px] leading-none truncate",
                done || active ? "text-neutral-700" : "text-neutral-400",
              ].join(" ")}
            >
              {stage.label}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export default function SourcesButton({
  disabled = false,
  onComplete,
}: {
  disabled?: boolean;
  onComplete?: () => void;
}) {
  const { state, message, trigger } = useJobPoller("/api/sources", onComplete);
  const isRunning = state === "running";
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const progress = progressPercent(state, message);
  const sourceProgress = parseSourceProgress(message);
  const displayMessage = userFacingSourceMessage(state, message);
  const pressCount = useMemo(() => PUBLISHERS.filter((p) => p.kind === "rss").length, []);
  const communityCount = useMemo(() => PUBLISHERS.filter((p) => p.kind === "reddit").length, []);
  const visiblePublishers = PUBLISHERS.slice(0, 14);
  const elapsed = startedAt && isRunning ? formatElapsed(now - startedAt) : null;

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  function handleRefresh() {
    setStartedAt(Date.now());
    trigger();
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white overflow-hidden shadow-sm">
      <div className="p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase text-emerald-700 font-semibold">
              MusicLife Sources
            </p>
            <p className="text-sm font-semibold text-neutral-900 leading-tight mt-0.5">
              Refresh discovery context
            </p>
          </div>
          <span
            className={[
              "shrink-0 px-2 py-1 rounded-full text-[10px] font-medium border",
              isRunning
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : state === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : state === "error"
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-neutral-200 bg-neutral-50 text-neutral-500",
            ].join(" ")}
          >
            {isRunning ? "Live" : state === "success" ? "Updated" : state === "error" ? "Needs retry" : "Ready"}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <Metric label="sources" value={SOURCE_COUNT.toString()} />
          <Metric label="press" value={pressCount.toString()} />
          <Metric label="reddit" value={communityCount.toString()} />
        </div>

        <div className="flex gap-1.5 overflow-hidden" aria-label="Publisher sources">
          {visiblePublishers.map((publisher) => (
            <SourceLogo key={`${publisher.kind}-${publisher.name}`} publisher={publisher} />
          ))}
          <div className="w-8 h-8 rounded-md border border-dashed border-neutral-200 bg-neutral-50 text-[10px] text-neutral-500 font-medium flex items-center justify-center shrink-0">
            +{SOURCE_COUNT - visiblePublishers.length}
          </div>
        </div>

        <button
          onClick={handleRefresh}
          disabled={disabled || isRunning}
          className="w-full min-h-[40px] px-3 py-2 rounded-md bg-neutral-950 text-white text-xs font-semibold hover:bg-neutral-800 disabled:opacity-45 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
        >
          {isRunning && (
            <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
          )}
          {isRunning ? "Refreshing sources" : "Refresh sources"}
        </button>

        {disabled ? (
          <p className="text-[10px] text-neutral-500 leading-snug">
            Sync your listening history first so MusicLife can connect fresh picks to your taste.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-[10px] text-neutral-500">
              <span>
                {sourceProgress
                  ? `${sourceProgress.current}/${sourceProgress.total} feeds scanned`
                  : state === "success"
                    ? "Source refresh complete"
                    : "Blogs, magazines, and music communities"}
              </span>
              {elapsed && <span>{elapsed}</span>}
            </div>
            <div className="h-2 rounded-full bg-neutral-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <StageRail state={state} message={message} />
          </div>
        )}

        {displayMessage && state !== "idle" && (
          <p
            className={[
              "text-[10px] leading-snug rounded-md px-2 py-1.5",
              state === "error"
                ? "bg-red-50 text-red-600"
                : state === "success"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-neutral-50 text-neutral-600",
            ].join(" ")}
          >
            {displayMessage}
          </p>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-100 bg-neutral-50 px-2 py-1.5">
      <p className="text-sm font-semibold text-neutral-900 leading-none">{value}</p>
      <p className="text-[9px] text-neutral-400 mt-1 leading-none">{label}</p>
    </div>
  );
}
