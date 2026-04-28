# Deploying MusicLife (Free)

No local installs needed. Everything runs in the browser.

**Time to deploy: ~20 minutes**

---

## Services you'll need (all free)

| Service | Sign up at | Used for |
|---------|-----------|---------|
| Supabase | supabase.com | Database |
| Vercel | vercel.com | Web frontend |
| Render | render.com | Python API |
| Spotify | developer.spotify.com | Music data + playback |
| Anthropic | console.anthropic.com | AI recommendations |
| Voyage AI | dash.voyageai.com | Embeddings (or use OpenAI) |
| Last.fm | last.fm/api | Artist metadata |

---

## Step 1 — Supabase (database)

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Name it `musiclife`, pick a region close to you, set a DB password
3. Once created, go to **SQL Editor**
4. Paste and run each file in order:
   - `db/migrations/001_init.sql`
   - `db/migrations/002_playlists.sql`
   - `db/migrations/003_rls.sql`
   - `db/migrations/004_ingest_constraints.sql`
   - `db/migrations/005_mentions_dedup.sql`
   - `db/migrations/006_triggers_and_indexes.sql`
   - `db/seed/sources.sql`
5. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon / public key** → `SUPABASE_ANON_KEY`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` *(keep this secret)*

---

## Step 2 — Spotify app

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. **Create app** → any name/description, set Website to your future Vercel URL
3. Under **Redirect URIs** add:
   - `https://your-app.vercel.app/api/auth/callback`
   *(you can update this after Vercel deploy — use a placeholder for now)*
4. Copy **Client ID** and **Client Secret**

---

## Step 3 — Other API keys

| Key | Where | Notes |
|-----|-------|-------|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | Free credits on signup |
| `VOYAGE_API_KEY` | dash.voyageai.com → API Keys | Free tier included |
| `LASTFM_API_KEY` | last.fm/api/account/create | Instant, free |

---

## Step 4 — Deploy the API on Render

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub account → select `WindyCityJump23/MusicLife`
3. Render will detect `render.yaml` automatically — click **Apply**
4. In the **Environment** tab, fill in these values (marked `sync: false` in render.yaml):

   | Key | Value |
   |-----|-------|
   | `SUPABASE_URL` | from Step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from Step 1 |
   | `SUPABASE_ANON_KEY` | from Step 1 |
   | `ANTHROPIC_API_KEY` | from Step 3 |
   | `VOYAGE_API_KEY` | from Step 3 |
   | `LASTFM_API_KEY` | from Step 3 |
   | `CORS_ORIGINS` | `https://your-app.vercel.app` *(update after Vercel deploy)* |

5. Click **Deploy** — wait for it to go green
6. Copy your Render URL (e.g. `https://musiclife-api.onrender.com`)

---

## Step 5 — Deploy the Web on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import `WindyCityJump23/MusicLife` from GitHub
3. Vercel detects `vercel.json` and sets root directory to `web` automatically
4. Under **Environment Variables**, add:

   | Key | Value |
   |-----|-------|
   | `NEXT_PUBLIC_SUPABASE_URL` | from Step 1 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from Step 1 |
   | `SPOTIFY_CLIENT_ID` | from Step 2 |
   | `SPOTIFY_CLIENT_SECRET` | from Step 2 |
   | `SPOTIFY_REDIRECT_URI` | `https://your-app.vercel.app/api/auth/callback` |
   | `NEXT_PUBLIC_API_URL` | your Render URL from Step 4 |

5. Click **Deploy** — wait for it to go green
6. Copy your Vercel URL (e.g. `https://musiclife.vercel.app`)

---

## Step 6 — Connect everything

1. **Update Spotify redirect URI**: go back to Spotify Dashboard → your app → add your real Vercel URL as redirect URI: `https://your-app.vercel.app/api/auth/callback`
2. **Update Render CORS**: Render → your service → Environment → set `CORS_ORIGINS` to your Vercel URL
3. **Update Vercel SPOTIFY_REDIRECT_URI**: set it to `https://your-app.vercel.app/api/auth/callback`

---

## Step 7 — First login

1. Open your Vercel URL → click **Connect with Spotify**
2. That's it — your account is created automatically

---

## Step 8 — Populate your library

In the dashboard sidebar (bottom left):

1. **Sync Spotify library** — imports your music (~30 seconds)
2. **Enrich artists** — fetches bios and tags (~2-5 minutes, runs at 1 req/s)
3. **Embed artists** — generates taste vectors (~1 minute)
4. **Fetch sources** — crawls music blogs and Reddit (~30 seconds)

After all four steps, the **Discover** tab returns real recommendations.

Friends can do the same — just share your Vercel URL. Each person logs in with their own Spotify and gets their own separate data.

---

## Your live URLs

| | URL |
|-|-----|
| App | `https://your-app.vercel.app` |
| API | `https://musiclife-api.onrender.com` |
| API docs | `https://musiclife-api.onrender.com/docs` |

---

## Notes

- **Render free tier sleeps** after 15 min of inactivity. First request after idle takes ~30s to wake up. Upgrade to $7/mo to keep it always on.
- **Vercel free tier** has no sleep — always instant.
- **Supabase free tier** pauses after 1 week of inactivity on the free plan — just click Resume in the dashboard.
