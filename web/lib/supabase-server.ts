import { createClient } from "@supabase/supabase-js";

// TODO: Switch to anon key + per-request Supabase JWT once auth is wired
// in the dashboard. Service role bypasses RLS, so we filter by TEST_USER_ID
// manually in the route handlers. This key MUST stay server-side.
export function supabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase env vars missing (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
