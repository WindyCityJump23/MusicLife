insert into public.sources (name, kind, url, trust_weight) values
  ('Resident Advisor', 'rss', 'https://ra.co/feed', 0.900),
  ('Stereogum', 'rss', 'https://www.stereogum.com/feed/', 0.820),
  ('Pitchfork News', 'rss', 'https://pitchfork.com/feed/feed-news/rss', 0.830),
  ('The Quietus', 'rss', 'https://thequietus.com/feed/', 0.780),
  ('Bandcamp Daily', 'rss', 'https://daily.bandcamp.com/feed', 0.860),
  ('Reddit r/indieheads', 'reddit', 'https://www.reddit.com/r/indieheads/.rss', 0.650),
  ('Reddit r/electronicmusic', 'reddit', 'https://www.reddit.com/r/electronicmusic/.rss', 0.630),
  ('Reddit r/hiphopheads', 'reddit', 'https://www.reddit.com/r/hiphopheads/.rss', 0.640)
on conflict (name) do nothing;
