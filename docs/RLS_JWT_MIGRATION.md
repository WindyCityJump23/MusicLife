# RLS / JWT activation runbook

**Status: designed, not yet activated. Requires staging validation before merge to the live auth path.**

## Why

Today every Next.js route handler uses `SUPABASE_SERVICE_ROLE_KEY` via
`supabaseServer()`, which **bypasses RLS**. User scoping is manual — each query
adds `.eq("user_id", userId)`. The policies in
`db/migrations/003_rls.sql` are correct but dormant. One forgotten filter on any
user-owned table leaks all users' rows.

This runbook activates RLS so Postgres enforces tenancy via `auth.uid()`,
turning the manual filters into defense-in-depth instead of the only defense.

## Building blocks already in place

- `web/lib/supabase-jwt.ts` — `mintSupabaseJwt(userId, secret)` / `verifySupabaseJwt`
  (HS256, no new deps), with tests in `web/lib/supabase-jwt.test.ts`.
- `api/tests/test_tenant_isolation.py` — cross-tenant contract test that proves
  scoped reads don't leak. **Run this green before and after the cutover.**
- RLS policies: `db/migrations/003_rls.sql` (+ later per-table RLS in 009–025).

## Cutover steps

1. **Add the secret.** Put the project JWT secret (Supabase → Settings → API →
   JWT Secret) into the web env as `SUPABASE_JWT_SECRET` (server-only; never
   `NEXT_PUBLIC_*`).

2. **Mint on OAuth callback.** In `web/app/api/auth/callback/route.ts`, after
   `supabaseUserId` is resolved, mint a short-lived JWT and set it as an
   httpOnly cookie alongside the existing identity cookies:

   ```ts
   import { mintSupabaseJwt } from "@/lib/supabase-jwt";
   const sbJwt = mintSupabaseJwt(supabaseUserId, process.env.SUPABASE_JWT_SECRET!, {
     expiresInSeconds: 60 * 60,
   });
   res.cookies.set("sb_jwt", sbJwt, { ...setCookieOpts(secure), maxAge: 60 * 60 });
   ```
   Mint the guest JWT in `web/app/api/import-playlist/route.ts` the same way.

3. **Refresh the JWT.** Add re-mint logic (mirror `spotify-token.ts`) so the
   `sb_jwt` cookie is rotated before expiry on each request that needs it.

4. **Per-request client.** Add `supabaseUser(req)` that builds a client with the
   anon key + `Authorization: Bearer <sb_jwt>` (the backend already supports this
   shape — see `api/app/services/supabase_client.py:get_user_scoped_supabase`).
   Keep `supabaseServer()` (service-role) only for cross-user catalog jobs.

5. **Migrate routes incrementally.** Switch user-owned route handlers from
   `supabaseServer()` to `supabaseUser(req)` one table at a time. With RLS
   active, `auth.uid()` resolves to `sub`, so the existing `.eq("user_id", …)`
   filters become redundant but harmless — leave them until every route is
   migrated, then remove in a dedicated pass.

6. **Verify policies cover every user-owned table.** As of this writing RLS is
   enabled on: users, user_tracks, listen_events, playlists, playlist_items,
   user_favorites, user_top_artists, user_feedback, user_taste_strategy,
   discover_history, station_cache, station_runs, recommendation_events,
   taste_snapshots, setup_jobs. Confirm with:

   ```sql
   select tablename, rowsecurity
   from pg_tables where schemaname = 'public' order by tablename;
   ```

7. **Gate on the contract test.** `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
   pytest api/tests/test_tenant_isolation.py` must pass against staging both
   before and after.

## Rollback

The `sb_jwt` cookie is additive. If anything misbehaves, revert the routes to
`supabaseServer()` (service-role) — RLS policies stay defined but dormant, i.e.
exactly today's behavior. No schema rollback needed.

## Why this isn't flipped automatically

A wrong JWT secret, `aud`/`role` claim, or an un-migrated route under active RLS
locks users out of their own data. It must be validated on staging with the
contract test before touching production auth.
