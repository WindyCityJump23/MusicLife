"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type JobStatusResponse = {
  status: "queued" | "running" | "success" | "failed" | "unknown";
  message: string;
  step?: number;
  total_steps?: number | null;
};

export type RunState = "idle" | "running" | "success" | "error";

export type SetupStatusSnapshot = {
  state: RunState;
  message: string;
  step: number;
  totalSteps: number;
  partialSuccess: boolean;
};

const TOTAL_STEPS = 6;
const STORAGE_KEY = "musiclife.setupAll.jobId";
const POLL_INTERVAL_MS = 2500;
const USER_FACING_STEP_LABELS = [
  "Importing your music",
  "Learning your artists",
  "Connecting your taste",
  "Adding music context",
  "Preparing playable songs",
  "Refining discovery",
];

function parseStep(message: string): { step: number; total: number; label: string } | null {
  const match = message.match(/^Step\s+(\d+)\/(\d+):\s*(.+)$/i);
  if (!match) return null;
  return {
    step: parseInt(match[1], 10),
    total: parseInt(match[2], 10),
    label: match[3].trim(),
  };
}

function userFacingSetupMessage(message: string): string {
  const parsed = parseStep(message);
  if (parsed && parsed.step >= 1 && parsed.step <= USER_FACING_STEP_LABELS.length) {
    return `Step ${parsed.step}/${parsed.total}: ${USER_FACING_STEP_LABELS[parsed.step - 1]}`;
  }

  const lower = message.toLowerCase();
  if (
    lower.includes("track catalog will update") ||
    lower.includes("embedding warning") ||
    lower.includes("radio needs")
  ) {
    return "Music profile ready. Some song matches are still updating.";
  }
  if (lower.includes("radio setup complete")) {
    return "Music profile ready. Radio is tuning your station.";
  }
  if (lower.includes("embedding") || lower.includes("vector") || lower.includes("model")) {
    return "Connecting your taste signals…";
  }
  if (lower.includes("catalog") || lower.includes("track")) {
    return "Preparing playable songs…";
  }
  if (lower.includes("enrich") || lower.includes("metadata")) {
    return "Learning your artists…";
  }
  return message;
}

export default function SetupAllButton({
  isReady = false,
  onProgress,
  onComplete,
  onStatusChange,
}: {
  isReady?: boolean;
  onProgress?: () => void;
  onComplete?: () => void;
  onStatusChange?: (status: SetupStatusSnapshot) => void;
}) {
  const [state, setState]     = useState<RunState>("idle");
  const [message, setMessage] = useState("");
  const [partialSuccess, setPartialSuccess] = useState(false);
  const [step, setStep]       = useState(0);
  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMessageRef = useRef("");
  const completedRef   = useRef(false);
  // Keep callbacks in refs so handleStatus / startPolling don't need them
  // in their dependency arrays — avoids re-creating those callbacks (and
  // re-firing the startPolling useEffect) on every parent render.
  const onProgressRef = useRef(onProgress);
  const onCompleteRef = useRef(onComplete);
  onProgressRef.current = onProgress;
  onCompleteRef.current = onComplete;

  useEffect(() => {
    onStatusChange?.({
      state,
      message,
      step,
      totalSteps: TOTAL_STEPS,
      partialSuccess,
    });
  }, [message, onStatusChange, partialSuccess, state, step]);

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const handleStatus = useCallback(
    (data: JobStatusResponse): boolean => {
      if (data.status === "queued" || data.status === "running") {
        setState("running");
        setMessage(userFacingSetupMessage(data.message || "Working…"));
        const parsed = parseStep(data.message || "");
        if (typeof data.step === "number" && data.step > 0) {
          setStep(data.step);
        } else if (parsed) {
          setStep(parsed.step);
        }
        if (data.message && data.message !== lastMessageRef.current) {
          lastMessageRef.current = data.message;
          onProgressRef.current?.();
        }
        return false;
      }
      if (data.status === "success") {
        cleanup();
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
        setState("success");
        setStep(TOTAL_STEPS);
        setMessage(userFacingSetupMessage(data.message || "Music profile ready"));
        const msg = (data.message || "").toLowerCase();
        setPartialSuccess(
          msg.includes("track catalog will update") || msg.includes("radio needs")
        );
        onProgressRef.current?.();
        if (!completedRef.current) {
          completedRef.current = true;
          onCompleteRef.current?.();
        }
        return true;
      }
      if (data.status === "failed") {
        cleanup();
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
        setState("error");
        setMessage(userFacingSetupMessage(data.message || "Setup failed"));
        return true;
      }
      // unknown — job expired or never existed
      cleanup();
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      setState("idle");
      setMessage("");
      setStep(0);
      return true;
    },
    [cleanup]
  );

  const startPolling = useCallback(
    (jobId: string) => {
      cleanup();
      const tick = async () => {
        try {
          const res = await fetch(`/api/job-status?id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
          if (!res.ok) return;
          const data: JobStatusResponse = await res.json();
          handleStatus(data);
        } catch {
          // transient — keep polling
        }
      };
      intervalRef.current = setInterval(tick, POLL_INTERVAL_MS);
      tick();
    },
    [cleanup, handleStatus]
  );

  // Resume any in-flight setup on mount.
  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch {}
    if (!stored) return;
    setState("running");
    setMessage("Reconnecting…");
    startPolling(stored);
  }, [startPolling]);

  const trigger = useCallback(async () => {
    cleanup();
    setState("running");
    setStep(0);
    setMessage("Starting…");
    setPartialSuccess(false);

    try {
      const res = await fetch("/api/setup-all", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setMessage(data.error ?? data.detail ?? `Failed (HTTP ${res.status})`);
        return;
      }
      const jobId: string | undefined = data.job_id;
      if (!jobId) {
        setState("success");
        setMessage("Queued — running in background");
        return;
      }
      try { localStorage.setItem(STORAGE_KEY, jobId); } catch {}
      setMessage("Queued…");
      startPolling(jobId);
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Network error");
    }
  }, [cleanup, startPolling]);

  const buttonLabel =
    state === "running" ? (step > 0 ? `Setting up… (${step}/${TOTAL_STEPS})` : "Starting…")
    : isReady || state === "success" ? "Refresh music profile"
    : "Set up music profile";

  const progressPct =
    state === "success" ? 100
    : state === "running" && step > 0 ? ((step - 0.5) / TOTAL_STEPS) * 100
    : 0;

  return (
    <div className="space-y-1.5">
      <button
        onClick={trigger}
        disabled={state === "running"}
        className="w-full px-3 py-2 rounded-md border border-emerald-500 bg-emerald-500 text-xs font-medium text-white hover:bg-emerald-600 hover:border-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {buttonLabel}
      </button>

      {state === "idle" && (
        <p className="text-[10px] text-neutral-500 leading-snug px-0.5">
          {isReady
            ? "Discovery uses your saved profile. Refresh after your Spotify taste changes or if results look stale."
            : "Run once to import Spotify, learn your taste, and prepare playable tracks."}
        </p>
      )}

      {state === "running" && (
        <div className="space-y-1 px-0.5">
          <div className="w-full h-2 bg-neutral-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="text-[10px] text-neutral-600 leading-snug">{message}</p>
          <p className="text-[10px] text-neutral-400 leading-snug">
            Runs on our servers. You can come back here to check progress.
          </p>
        </div>
      )}

      {state === "success" && (
        <p className={`text-[11px] px-0.5 ${partialSuccess ? "text-amber-600" : "text-emerald-600"}`}>
          {partialSuccess ? "⚠" : "✓"} {message}
        </p>
      )}

      {state === "error" && (
        <p className="text-[11px] text-red-500 px-0.5">✗ {message}</p>
      )}
    </div>
  );
}
