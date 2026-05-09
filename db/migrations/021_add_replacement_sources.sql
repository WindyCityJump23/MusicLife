-- Replace disabled editorial sources with working alternatives.
-- Covers electronic, indie, hip-hop gaps left by migration 020.

-- Re-enable Exclaim with its working Feedburner URL
UPDATE public.sources
SET active = true, url = 'http://feeds.feedburner.com/ExclaimCaAllArticles'
WHERE name = 'Exclaim';

-- New sources
INSERT INTO public.sources (name, kind, url, trust_weight) VALUES
  ('Crack Magazine',      'rss', 'https://crackmagazine.net/feed/',          0.790),
  ('DJ Mag',              'rss', 'https://djmag.com/rss.xml',               0.770),
  ('Aquarium Drunkard',   'rss', 'https://aquariumdrunkard.com/feed/',       0.780),
  ('The Needle Drop',     'rss', 'https://theneedledrop.com/feed/',          0.730),
  ('The Wire',            'rss', 'https://www.thewire.co.uk/home/rss',      0.810),
  ('Treble',              'rss', 'https://www.treblezine.com/feed/',         0.740),
  ('Reddit r/synthwave',  'reddit', 'https://www.reddit.com/r/synthwave/.rss', 0.620),
  ('Reddit r/shoegaze',   'reddit', 'https://www.reddit.com/r/shoegaze/.rss', 0.610),
  ('Reddit r/DnB',        'reddit', 'https://www.reddit.com/r/DnB/.rss',     0.610)
ON CONFLICT (name) DO NOTHING;
