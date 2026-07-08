import { NextRequest, NextResponse } from "next/server";
import { requireUser, isErrorResponse } from "@/lib/session";

export const dynamic = "force-dynamic";
const UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * GET /api/personal-presets
 *
 * Mood presets derived from the user's own taste clusters (see the backend's
 * /recommend/personal-presets). The client caches the result for a day, so
 * this is called rarely. Failures return an empty list — the chip row just
 * shows curated presets.
 */
export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isErrorResponse(user)) return user;

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiUrl || !serviceRoleKey) {
    return NextResponse.json({ presets: [] });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${apiUrl}/recommend/personal-presets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({ user_id: user.userId }),
    });
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json({ presets: Array.isArray(data.presets) ? data.presets : [] });
  } catch (err) {
    console.warn("personal-presets: upstream failed", err);
    return NextResponse.json({ presets: [] });
  } finally {
    clearTimeout(timeout);
  }
}
