import { NextResponse } from "next/server";

export async function POST() {
  const upstream = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/ingest/embed-artists`,
    { method: "POST" }
  );
  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
