import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = req.cookies.get("app_user_id")?.value ?? "(not set)";
  const displayName = req.cookies.get("app_display_name")?.value ?? "(not set)";
  return NextResponse.json({ userId, displayName });
}
