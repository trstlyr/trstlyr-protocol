.PHONY: dev api web build stop logs clean help

# ─── Local development ────────────────────────────────────────────────────────

## dev: Start API (Docker) + Web UI (Next.js hot reload)
dev:
	@echo "⛵ Starting TrstLyr locally..."
	@cp -n .env.example .env 2>/dev/null && echo "  Created .env from .env.example" || true
	@docker compose up -d
	@echo "  API  → http://localhost:3000"
	@echo "  UI   → http://localhost:3001 (starting...)"
	@echo ""
	pnpm --filter @trstlyr/web dev

## api: Start API only (Docker)
api:
	@cp -n .env.example .env 2>/dev/null || true
	docker compose up -d
	@echo "  API  → http://localhost:3000"
	@echo "  Docs → http://localhost:3000/skill.md"

## web: Start web UI only (assumes API is already running)
web:
	pnpm --filter @trstlyr/web dev

## stop: Stop all Docker services
stop:
	docker compose down

## logs: Tail API logs
logs:
	docker compose logs -f api

# ─── Build ────────────────────────────────────────────────────────────────────

## build: Build all packages
build:
	pnpm --filter @trstlyr/core build
	pnpm --filter @trstlyr/api build
	pnpm --filter @trstlyr/web build

## install: Install all dependencies
install:
	pnpm install

# ─── Cleanup ──────────────────────────────────────────────────────────────────

## clean: Remove build artifacts
clean:
	rm -rf packages/core/dist apps/api/dist apps/web/.next

## help: Show this help
help:
	@grep -E '^## ' Makefile | sed 's/## /  /'
