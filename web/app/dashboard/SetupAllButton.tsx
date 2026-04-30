"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type JobStatusResponse = {
  status: "queued" | "running" | "success" | "failed" | "unknown";
  message: string;
};

type RunState = "idle" | "running" | "success" | "error";

const TOTAL_STEPS = 5;
const STORAGE_KEY = "musiclife.setupAll.jobId";
const LEADER_KEY = "musiclife.setupAll.pollLeader";
const TAB_ID_KEY = "musiclife.setupAll.tabId";
const POLL_INTERVAL_MS = 2500;
const LEADER_STALE_MS = 8000;

function parseStep(message: string): { step: number; totalSteps: number; label: string; processed?: number; total?: number } | null {
  const match = message.match(/^Step\s+(\d+)\/(\d+):\s*(.+)$/i);
  if (!match) return null;
  const label = match[3].trim();
  const progressMatch = label.match(/\((\d+)\/(\d+)\)/);
  return {
    step: parseInt(match[1], 10),
    totalSteps: parseInt(match[2], 10),
    label,
    processed: progressMatch ? parseInt(progressMatch[1], 10) : undefined,
    total: progressMatch ? parseInt(progressMatch[2], 10) : undefined,
  };
}

export default function SetupAllButton({ onProgress }: { onProgress?: () => void }) {
  const [state, setState]     = useState<RunState>("idle");
  const [message, setMessage] = useState("");
  const [step, setStep]       = useState(0);
  const [itemProgress, setItemProgress] = useState<{ processed: number; total: number } | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMessageRef = useRef("");

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearTimeout(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  useEffect(() => {
    try {
      const existing = localStorage.getItem(TAB_ID_KEY);
      if (existing) {
        tabIdRef.current = existing;
      } else {
        const created = getOrCreateTabId();
        tabIdRef.current = created;
        localStorage.setItem(TAB_ID_KEY, created);
      }
    } catch {
      tabIdRef.current = getOrCreateTabId();
    }
  }, []);

  const tryBecomeLeader = useCallback(() => {
    const now = Date.now();
    const mine = tabIdRef.current || getOrCreateTabId();
    tabIdRef.current = mine;
    try {
      const raw = localStorage.getItem(LEADER_KEY);
      const leader = raw ? JSON.parse(raw) as { tabId?: string; ts?: number } : null;
      const stale = !leader?.ts || (now - leader.ts) > LEADER_STALE_MS;
      if (!leader?.tabId || leader.tabId === mine || stale) {
        localStorage.setItem(LEADER_KEY, JSON.stringify({ tabId: mine, ts: now }));
        hasLeaderRef.current = true;
        return true;
      }
      hasLeaderRef.current = false;
      return false;
    } catch {
      hasLeaderRef.current = true;
      return true;
    }
  }, []);

  const heartbeatLeader = useCallback(() => {
    if (!hasLeaderRef.current) return;
    const mine = tabIdRef.current;
    if (!mine) return;
    try {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ tabId: mine, ts: Date.now() }));
    } catch {}
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LEADER_KEY) return;
      tryBecomeLeader();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [tryBecomeLeader]);

  useEffect(() => () => {
    if (!hasLeaderRef.current) return;
    const mine = tabIdRef.current;
    try {
      const raw = localStorage.getItem(LEADER_KEY);
      const leader = raw ? JSON.parse(raw) as { tabId?: string } : null;
      if (leader?.tabId === mine) {
        localStorage.removeItem(LEADER_KEY);
      }
    } catch {}
  }, []);

  const handleStatus = useCallback(
    (data: JobStatusResponse) => {
      if (data.status === "queued" || data.status === "running") {
        setState("running");
        setMessage(data.message || "Working…");
        const parsed = parseStep(data.message || "");
        if (parsed) {
          setStep(parsed.step);
          if (parsed.processed !== undefined && parsed.total !== undefined && parsed.total > 0) {
            setItemProgress({ processed: parsed.processed, total: parsed.total });
          }
        }
        if (data.message && data.message !== lastMessageRef.current) {
          lastMessageRef.current = data.message;
          onProgress?.();
        }
        return false;
      }
      if (data.status === "success") {
        cleanup();
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
        setState("success");
        setStep(TOTAL_STEPS);
        setMessage(data.message || "Library is ready");
        setItemProgress(null);
        onProgress?.();
        return true;
      }
      if (data.status === "failed") {
        cleanup();
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
        setState("error");
        setMessage(data.message || "Setup failed");
        setItemProgress(null);
        return true;
      }
      // unknown — job expired or never existed
      cleanup();
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      setState("idle");
      setMessage("");
      setStep(0);
      setItemProgress(null);
      return true;
    },
    [cleanup, onProgress]
  );

  const startPolling = useCallback(
    (jobId: string) => {
      cleanup();
      const tick = async () => {
        if (!tryBecomeLeader()) {
          intervalRef.current = setTimeout(tick, POLL_INTERVAL_MS);
          return;
        }
        heartbeatLeader();
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        try {
          const res = await fetch(`/api/job-status?id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
          if (!res.ok) return;
          const data: JobStatusResponse = await res.json();
          const done = handleStatus(data);
          if (done) return;
        } catch {
          // transient — keep polling
        } finally {
          inFlightRef.current = false;
          intervalRef.current = setTimeout(tick, POLL_INTERVAL_MS);
        }
      };
      tick();
    },
    [cleanup, handleStatus, heartbeatLeader, tryBecomeLeader]
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
    setItemProgress(null);

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
    : state === "success" ? "Re-run setup"
    : "Set up my library";

  const progressPct =
    state === "success" ? 100
    : state === "running" && itemProgress && step === TOTAL_STEPS
      ? (((step - 1) + (itemProgress.processed / itemProgress.total)) / TOTAL_STEPS) * 100
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
            Runs on our servers — safe to close this tab. Steps will keep ticking off when you return.
          </p>
        </div>
      )}

      {state === "success" && (
        <p className="text-[11px] text-emerald-600 px-0.5">✓ {message}</p>
      )}

      {state === "error" && (
        <p className="text-[11px] text-red-500 px-0.5">✗ {message}</p>
      )}
    </div>
  );
}
