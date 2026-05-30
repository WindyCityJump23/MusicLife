import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase-server";
import { createTasteSnapshot } from "@/lib/taste-snapshot";

export const dynamic = "force-dynamic";

/**
 * GET /api/job-status?id=<job_id>
 *   Poll a specific job by ID.
 *
 * GET /api/job-status
 *   Get the latest status for all job kinds (used by sidebar to show
 *   completion state without tracking individual IDs).
 */
export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 500 });
  }

  const jobId = req.nextUrl.searchParams.get("id");
  const url = jobId
    ? `${apiUrl}/ingest/status/${encodeURIComponent(jobId)}`
    : `${apiUrl}/ingest/status`;

  const upstream = await fetch(url, {
    headers: { Authorization: `Bearer ${serviceRoleKey}` },
    cache: "no-store",
  });

  const data = await upstream.json().catch(() => ({}));

  if (upstream.ok && jobId && data?.status === "success") {
    await createTasteSnapshot({
      sb: supabaseServer(),
      userId: user.userId,
      reason: `setup_all:${jobId}`,
      dedupeReason: true,
    });
  }

  return NextResponse.json(data, { status: upstream.status });
}
