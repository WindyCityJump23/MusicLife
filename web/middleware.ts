import { NextRequest, NextResponse } from "next/server";

// Protect all /dashboard routes — redirect to home if no session cookie.
export function middleware(req: NextRequest) {
  const userId = req.cookies.get("app_user_id")?.value;
  if (!userId) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
