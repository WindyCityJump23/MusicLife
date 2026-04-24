# TODO: implement Spotify library ingestion.
# Called from routes/ingest.py via background task.
# Steps:
#   1. GET /me/tracks (saved tracks, paginate)
#   2. GET /me/top/artists (short/medium/long term)
#   3. GET /me/player/recently-played
#   4. Upsert artists + tracks into Supabase; insert listen events.
