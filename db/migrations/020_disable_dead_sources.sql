-- Disable RSS sources that consistently return 404/403.
-- These sites have either shut down or removed their feeds.

UPDATE public.sources SET active = false WHERE name IN (
  'Resident Advisor',
  'Hype Machine Popular',
  'Hype Machine Latest',
  'Pigeons & Planes',
  'KEXP',
  'Exclaim',
  'Under the Radar'
);
