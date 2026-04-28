import { createClient } from "@supabase/supabase-js";

// SECURITY: Uses service role key, bypassing RLS. User scoping is manual
// via .eq('user_id', ...) in route handlers. See docs/PRODUCTION_AUDIT.md
// "Known Security Posture" for the migration path to per-request JWTs.
export function supabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase env vars missing (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
