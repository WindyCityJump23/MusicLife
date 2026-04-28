import { useCallback, useEffect, useRef, useState } from "react";

export type JobState = "idle" | "running" | "success" | "error";

type JobStatusResponse = {
  status: "queued" | "running" | "success" | "failed" | "unknown";
  message: string;
};

/**
 * Hook that fires a POST to start a job, then polls /api/job-status?id=<jobId>
 * until it reaches a terminal state (success or failed).
 *
 * Returns { state, message, trigger } where trigger() kicks off the job.
 */
export function useJobPoller(endpoint: string, onComplete?: () => void, maxPolls = 600) {
  const [state, setState] = useState<JobState>("idle");
  const [message, setMessage] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const pollJob = useCallback(
    (jobId: string) => {
      let polls = 0;

      intervalRef.current = setInterval(async () => {
        polls++;
        if (polls > maxPolls) {
          cleanup();
          setState("error");
          setMessage("UI polling stopped — the job may still be running on the server. Refresh the page to check.");
          return;
        }

        try {
          const res = await fetch(`/api/job-status?id=${encodeURIComponent(jobId)}`, {
            cache: "no-store",
          });
          if (!res.ok) return; // keep polling on transient failures

          const data: JobStatusResponse = await res.json();

          if (data.status === "running" || data.status === "queued") {
            setMessage(data.message || "Working...");
            return; // keep polling
          }

          if (data.status === "success") {
            cleanup();
            setState("success");
            setMessage(data.message || "Done!");
            onComplete?.();
            return;
          }

          if (data.status === "failed") {
            cleanup();
            setState("error");
            setMessage(data.message || "Job failed");
            return;
          }

          // "unknown" — job expired or not found, stop polling
          if (data.status === "unknown") {
            cleanup();
            setState("error");
            setMessage("Lost track of job — it may have completed. Refresh the page to check.");
            return;
          }
        } catch {
          // Transient network error — keep polling
        }
      }, 2500);
    },
    [cleanup]
  );

  const trigger = useCallback(async () => {
    cleanup();
    setState("running");
    setMessage("Starting...");

    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setState("error");
        setMessage(data.error ?? data.detail ?? `Failed (HTTP ${res.status})`);
        return;
      }

      const jobId: string | undefined = data.job_id;
      if (!jobId) {
        // Fallback: no job_id returned, assume old API — show queued message
        setState("success");
        setMessage("Queued — running in background");
        return;
      }

      jobIdRef.current = jobId;
      setMessage("Queued...");
      pollJob(jobId);
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Network error");
    }
  }, [endpoint, cleanup, pollJob]);

  return { state, message, trigger };
}
