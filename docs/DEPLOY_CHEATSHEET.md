# Deploy Cheat Sheet

Do these steps in order. Takes about 20 minutes total.

---

## 1. Supabase — Database (5 min)

1. Go to **[supabase.com](https://supabase.com)** → Sign up → **New project**
2. Name: `musiclife` | Pick a region | Set a DB password (save it)
3. Wait ~2 min for project to spin up
4. Go to **SQL Editor** → paste and run each file in order:
   - `db/migrations/001_init.sql`
   - `db/migrations/002_playlists.sql`
   - `db/migrations/003_rls.sql`
   - `db/migrations/004_ingest_constraints.sql`
   - `db/migrations/005_mentions_dedup.sql`
   - `db/migrations/006_triggers_and_indexes.sql`
   - `db/migrations/007_users_display_name.sql`
   - `db/seed/sources.sql`
5. Go to **Project Settings → API** → copy and save these 3 values:
   - **Project URL** → this is your `SUPABASE_URL`
   - **anon / public** key → this is your `SUPABASE_ANON_KEY`
   - **service_role** key → this is your `SUPABASE_SERVICE_ROLE_KEY`

---

## 2. Spotify — App credentials (3 min)

1. Go to **[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)** → Log in → **Create app**
2. Fill in:
   - App name: `MusicLife`
   - Redirect URIs: `https://PLACEHOLDER.vercel.app/api/auth/callback`
     *(you'll update this after Vercel deploys)*
   - Check: Web API + Web Playback SDK
3. Click **Save** → go to **Settings** → copy:
   - **Client ID** → this is your `SPOTIFY_CLIENT_ID`
   - **Client Secret** → this is your `SPOTIFY_CLIENT_SECRET`

---

## 3. Anthropic — AI key (2 min)

1. Go to **[console.anthropic.com](https://console.anthropic.com)** → Sign up
2. Go to **API Keys** → **Create Key** → copy it
   - This is your `ANTHROPIC_API_KEY`

---

## 4. Voyage AI — Embeddings key (2 min)

1. Go to **[dash.voyageai.com](https://dash.voyageai.com)** → Sign up
2. Go to **API Keys** → create one → copy it
   - This is your `VOYAGE_API_KEY`

---

## 5. Last.fm — Music metadata key (2 min)

1. Go to **[last.fm/api/account/create](https://www.last.fm/api/account/create)** → Log in or sign up
2. Fill in the form (any app name/description) → Submit
3. Copy the **API key**
   - This is your `LASTFM_API_KEY`

---

## 6. Render — Deploy the API (5 min)

1. Go to **[render.com](https://render.com)** → Sign up with GitHub
2. Click **New +** → **Web Service**
3. Connect repo: `WindyCityJump23/MusicLife`
4. Render detects `render.yaml` automatically → click **Apply**
5. Go to **Environment** tab and fill in these values:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
| `SUPABASE_ANON_KEY` | from step 1 |
| `ANTHROPIC_API_KEY` | from step 3 |
| `VOYAGE_API_KEY` | from step 4 |
| `LASTFM_API_KEY` | from step 5 |
| `CORS_ORIGINS` | `https://PLACEHOLDER.vercel.app` *(update after step 7)* |

6. Click **Save Changes** → **Deploy** → wait for green ✓
7. Copy your Render URL: `https://musiclife-api.onrender.com`
   *(yours may be slightly different — use whatever Render shows)*

---

## 7. Vercel — Deploy the Web App (5 min)

1. Go to **[vercel.com](https://vercel.com)** → Sign up with GitHub
2. Click **Add New Project** → Import `WindyCityJump23/MusicLife`
3. Vercel auto-detects `vercel.json` → root directory is set to `web`
4. Under **Environment Variables**, add:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | from step 1 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
| `SPOTIFY_CLIENT_ID` | from step 2 |
| `SPOTIFY_CLIENT_SECRET` | from step 2 |
| `SPOTIFY_REDIRECT_URI` | `https://YOUR-APP.vercel.app/api/auth/callback` *(use your real URL)* |
| `NEXT_PUBLIC_API_URL` | your Render URL from step 6 |

5. Click **Deploy** → wait for green ✓
6. Copy your Vercel URL: `https://your-app.vercel.app`

---

## 8. Wire everything together (2 min)

### Update Spotify redirect URI
1. Go back to **[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)**
2. Open your app → **Settings**
3. Under **Redirect URIs** → edit → replace the placeholder with your real Vercel URL:
   `https://your-app.vercel.app/api/auth/callback`
4. Click **Save**

### Update Render CORS
1. Go to Render → your service → **Environment**
2. Update `CORS_ORIGINS` to your real Vercel URL: `https://your-app.vercel.app`
3. Click **Save Changes** → Render redeploys automatically

### Update Vercel SPOTIFY_REDIRECT_URI
1. Go to Vercel → your project → **Settings → Environment Variables**
2. Update `SPOTIFY_REDIRECT_URI` to: `https://your-app.vercel.app/api/auth/callback`
3. Go to **Deployments** → **Redeploy** (top right)

---

## 9. You're live!

Open your Vercel URL → click **Connect with Spotify** → you're in.

Share the URL with friends — they just click Connect with Spotify and get their own account automatically.

### First time in the dashboard:
1. Click **Sync Spotify library** — imports your music
2. Click **Enrich artists** — fetches bios (2-5 min, runs in background)
3. Click **Embed artists** — generates taste vectors
4. Click **Fetch sources** — crawls music blogs and Reddit
5. Go to **Discover** → type anything → get recommendations

---

## Your URLs

| | URL |
|-|-----|
| 🌐 App | `https://your-app.vercel.app` |
| ⚙️ API | `https://musiclife-api.onrender.com` |
| 📋 API docs | `https://musiclife-api.onrender.com/docs` |
| ❤️ Health | `https://musiclife-api.onrender.com/health` |

---

## Notes

- **Render free tier** sleeps after 15 min idle — first request after waking takes ~30s. Fine for personal use. Upgrade to $7/mo for always-on.
- **Vercel free tier** never sleeps.
- **Supabase free tier** pauses after 1 week of inactivity — click Resume in the dashboard if it does.
- Auto-deploys are on by default — every time you push to GitHub, both platforms rebuild automatically.
