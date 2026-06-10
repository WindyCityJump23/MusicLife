"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReadinessPayload } from "@/lib/readiness";

/**
 * Single shared poller for `/api/readiness`.
 *
 * Previously setup-banner, sidebar, and radio-view each polled this endpoint
 * every 30s independently — three overlapping requests doing the same heavy
 * chunked count queries. This provider fetches once on mount, polls on one
 * interval, and exposes `refresh()` so any consumer can force an immediate
 * re-check (e.g. right after a setup step completes).
 */

type ReadinessContextValue = {
  data: ReadinessPayload | null;
  loading: boolean;
  refresh: () => Promise<ReadinessPayload | null>;
};

const ReadinessContext = createContext<ReadinessContextValue | null>(null);

const POLL_INTERVAL_MS = 30_000;

export function ReadinessProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<ReadinessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  // De-dupe concurrent refreshes (a step-complete callback firing while the
  // interval tick is mid-flight) so we never stack identical requests.
  const inFlightRef = useRef<Promise<ReadinessPayload | null> | null>(null);

  const refresh = useCallback(async (): Promise<ReadinessPayload | null> => {
    if (inFlightRef.current) return inFlightRef.current;
    const promise = (async () => {
      try {
        const res = await fetch("/api/readiness", { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as ReadinessPayload | null;
        if (res.ok && json) {
          setData(json);
          return json;
        }
        return null;
      } catch {
        return null;
      } finally {
        setLoading(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <ReadinessContext.Provider value={{ data, loading, refresh }}>
      {children}
    </ReadinessContext.Provider>
  );
}

export function useReadiness(): ReadinessContextValue {
  const ctx = useContext(ReadinessContext);
  if (!ctx) {
    throw new Error("useReadiness must be used within a ReadinessProvider");
  }
  return ctx;
}
