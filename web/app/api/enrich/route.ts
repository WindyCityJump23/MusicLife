import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }
  const upstream = await fetch(`${apiUrl}/ingest/enrich-artists`, { method: "POST" });
  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
