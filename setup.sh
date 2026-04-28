#!/bin/bash
# MusicLife – one-time setup script
# Run this once, fill in your keys, then: docker compose up

set -e

echo ""
echo "🎵 MusicLife Setup"
echo "=================="
echo ""

# Scaffold env files
if [ ! -f web/.env.local ]; then
  cp web/.env.local.example web/.env.local
  echo "✓ Created web/.env.local"
else
  echo "→ web/.env.local already exists"
fi

if [ ! -f api/.env ]; then
  cp api/.env.example api/.env
  echo "✓ Created api/.env"
else
  echo "→ api/.env already exists"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Next steps:"
echo ""
echo "  1. Fill in web/.env.local with your:"
echo "       - Supabase URL + keys"
echo "       - Spotify Client ID + Secret"
echo "       - SUPABASE_SERVICE_ROLE_KEY"
echo ""
echo "  2. Fill in api/.env with your:"
echo "       - Supabase URL + keys"
echo "       - Anthropic API key"
echo "       - Voyage AI or OpenAI key"
echo "       - Last.fm API key"
echo ""
echo "  3. Run your DB migrations in Supabase SQL Editor:"
echo "       db/migrations/001_init.sql through 006_triggers_and_indexes.sql"
echo "       db/seed/sources.sql"
echo ""
echo "  4. Start everything:"
echo "       docker compose up"
echo ""
echo "  5. Open http://localhost:3000 → Connect Spotify"
echo "     Copy your user UUID from Supabase → Authentication → Users"
echo "     Add it to web/.env.local as TEST_USER_ID=<uuid>"
echo "     Then restart: docker compose restart web"
echo ""
echo "  Full docs: README.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
