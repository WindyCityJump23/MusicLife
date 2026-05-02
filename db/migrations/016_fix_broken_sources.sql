-- Consolidated fix for broken/missing sources and missing dedup constraint.
-- Safe to run multiple times (all statements are idempotent).

-- 1. Add mentions dedup constraint if not already present
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mentions_dedup_key'
  ) THEN
    -- Remove duplicate rows first (keep the one with the highest id)
    DELETE FROM public.mentions
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM public.mentions
      GROUP BY source_id, url, artist_id
    );

    ALTER TABLE public.mentions
      ADD CONSTRAINT mentions_dedup_key UNIQUE (source_id, url, artist_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_published
      ON public.mentions(published_at DESC);
  END IF;
END $$;

-- 2. Fix FADER feed URL
UPDATE public.sources
SET url = 'https://www.thefader.com/feed'
WHERE name = 'FADER' AND url = 'https://www.thefader.com/rss';

-- 3. Deactivate The Quietus (returns 403 Forbidden — blocks our ingest user-agent)
UPDATE public.sources
SET active = false
WHERE name = 'The Quietus';

-- 4. Fix Resident Advisor feed URL (ra.co/feed returns 0 entries)
UPDATE public.sources
SET url = 'https://ra.co/xml/rss.xml'
WHERE name = 'Resident Advisor';

-- 5. Add new blog sources from migration 014 (if not already present)
INSERT INTO public.sources (name, kind, url, trust_weight) VALUES
  ('Hype Machine Popular',  'rss', 'https://hypem.com/popular/rss',                       0.840),
  ('Hype Machine Latest',   'rss', 'https://hypem.com/latest/rss',                        0.800),
  ('Pigeons & Planes',      'rss', 'https://pigeonsandplanes.com/feed/',                  0.770),
  ('KEXP',                  'rss', 'https://www.kexp.org/feed/',                          0.810),
  ('Paste Magazine Music',  'rss', 'https://www.pastemagazine.com/music/feed/',            0.760),
  ('DIY Magazine',          'rss', 'https://diymag.com/feed',                             0.750),
  ('Under the Radar',       'rss', 'https://www.undertheradarmag.com/news/rss/',           0.760),
  ('Exclaim',               'rss', 'https://exclaim.ca/music/rss',                        0.750),
  ('Gorilla vs Bear',       'rss', 'https://www.gorillavsbear.net/feed/',                 0.780),
  ('Reddit r/indiefolk',    'reddit', 'https://www.reddit.com/r/indiefolk/.rss',          0.640),
  ('Reddit r/newmusic',     'reddit', 'https://www.reddit.com/r/newmusic/.rss',           0.670)
ON CONFLICT (name) DO NOTHING;
