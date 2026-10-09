.PHONY: install dev test check

install:
	cd backend && uv sync
	cd frontend && npm install

dev:
	./scripts/dev.sh

test:
	cd backend && uv run pytest
	cd frontend && npm test

check:
	cd backend && uv run ruff check && uv run ruff format --check
	cd frontend && npm run check
