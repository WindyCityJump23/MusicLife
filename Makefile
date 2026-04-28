# MusicLife – local development helpers
# Run `make` or `make dev` to start both services at once.
# Requires: Node 20+, Python 3.11+, and all env files filled in.

.PHONY: dev api web install install-api install-web migrate help

# ── Start both services in parallel ────────────────────────────────────────
dev: install
	@echo "\n▶  Starting API on http://localhost:8000"
	@echo "▶  Starting Web on http://localhost:3000\n"
	@(cd api && .venv/bin/uvicorn app.main:app --reload --port 8000) &
	@(cd web && npm run dev)

# ── Individual service targets ──────────────────────────────────────────────
api: install-api
	cd api && .venv/bin/uvicorn app.main:app --reload --port 8000

web: install-web
	cd web && npm run dev

# ── Install dependencies ────────────────────────────────────────────────────
install: install-api install-web

install-api:
	@if [ ! -d api/.venv ]; then \
		echo "→ Creating Python venv…"; \
		python3 -m venv api/.venv; \
	fi
	@echo "→ Installing Python deps…"
	api/.venv/bin/pip install -q -r api/requirements.txt

install-web:
	@echo "→ Installing Node deps…"
	cd web && npm install --silent

# ── Database ────────────────────────────────────────────────────────────────
# Runs all migrations in order via psql. Requires DATABASE_URL env var.
# Example: DATABASE_URL=postgres://... make migrate
migrate:
	@if [ -z "$$DATABASE_URL" ]; then \
		echo "ERROR: DATABASE_URL is not set."; \
		echo "Export it first: export DATABASE_URL=postgres://user:pass@host/db"; \
		exit 1; \
	fi
	@for f in db/migrations/*.sql; do \
		echo "→ Running $$f…"; \
		psql "$$DATABASE_URL" -f "$$f"; \
	done
	@echo "→ Seeding sources…"
	psql "$$DATABASE_URL" -f db/seed/sources.sql
	@echo "✓ Migrations complete"

# ── Env file scaffolding ────────────────────────────────────────────────────
env:
	@if [ ! -f web/.env.local ]; then \
		cp web/.env.local.example web/.env.local; \
		echo "→ Created web/.env.local — fill in your values"; \
	else \
		echo "→ web/.env.local already exists"; \
	fi
	@if [ ! -f api/.env ]; then \
		cp api/.env.example api/.env; \
		echo "→ Created api/.env — fill in your values"; \
	else \
		echo "→ api/.env already exists"; \
	fi

help:
	@echo ""
	@echo "  make env        Copy env templates (do this first)"
	@echo "  make install    Install all dependencies"
	@echo "  make dev        Start API + Web together"
	@echo "  make api        Start API only"
	@echo "  make web        Start Web only"
	@echo "  make migrate    Run all DB migrations (requires DATABASE_URL)"
	@echo ""
