"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type JobStatusResponse = {
  status: "queued" | "running" | "success" | "failed" | "unknown";
  message: string;
};

type Stage = { label: string; running: string; endpoint: string };

const STAGES: Stage[] = [
  { label: "Sync Library",        running: "Syncing Spotify library",  endpoint: "/api/sync" },
  { label: "Enrich Artists",      running: "Enriching artists",        endpoint: "/api/enrich" },
  { label: "Generate Embeddings", running: "Generating embeddings",    endpoint: "/api/embed" },
  { label: "Sync Sources",        running: "Fetching editorial sources", endpoint: "/api/sources" },
  { label: "Populate Tracks",     running: "Populating track catalog", endpoint: "/api/populate-tracks" },
];

type RunState = "idle" | "running" | "success" | "error";

export default function SetupAllButton({ onProgress }: { onProgress?: () => void }) {
  const [state, setState]       = useState<RunState>("idle");
  const [stageIdx, setStageIdx] = useState(0);
  const [message, setMessage]   = useState("");
  const cancelRef = useRef(false);

  useEffect(() => () => { cancelRef.current = true; }, []);

  const runStage = useCallback(async (stage: Stage): Promise<void> => {
    const startRes = await fetch(stage.endpoint, { method: "POST" });
    const startData = await startRes.json().catch(() => ({}));
    if (!startRes.ok) {
      throw new Error(startData.error ?? startData.detail ?? `Failed (HTTP ${startRes.status})`);
    }

    const jobId: string | undefined = startData.job_id;
    if (!jobId) return; // legacy API: fire-and-forget

    return new Promise<void>((resolve, reject) => {
      const tick = async () => {
        if (cancelRef.current) return reject(new Error("cancelled"));
        try {
          const res = await fetch(`/api/job-status?id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
          if (!res.ok) return; // keep polling on transient failures
          const data: JobStatusResponse = await res.json();
          if (data.status === "running" || data.status === "queued") {
            setMessage(data.message || stage.running);
            return;
          }
          clearInterval(handle);
          if (data.status === "success") {
            onProgress?.();
            return resolve();
          }
          reject(new Error(data.message || `${stage.label} failed`));
        } catch {
          // transient error — keep polling
        }
      };
      const handle = setInterval(tick, 2500);
      tick();
    });
  }, [onProgress]);

  const trigger = useCallback(async () => {
    cancelRef.current = false;
    setState("running");
    setStageIdx(0);
    setMessage("Starting…");

    try {
      for (let i = 0; i < STAGES.length; i++) {
        setStageIdx(i);
        setMessage(STAGES[i].running + "…");
        await runStage(STAGES[i]);
        onProgress?.();
      }
      setState("success");
      setMessage("Library is ready");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Setup failed");
    }
  }, [runStage, onProgress]);

  const buttonLabel =
    state === "running" ? `Step ${stageIdx + 1} of ${STAGES.length}: ${STAGES[stageIdx].label}…`
    : state === "success" ? "Re-run setup"
    : "Set up my library";

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
              style={{ width: `${((stageIdx + 0.5) / STAGES.length) * 100}%` }}
            />
          </div>
          <p className="text-[10px] text-neutral-500">{message}</p>
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
