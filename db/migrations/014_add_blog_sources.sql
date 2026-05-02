insert into public.sources (name, kind, url, trust_weight) values
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
on conflict (name) do nothing;
