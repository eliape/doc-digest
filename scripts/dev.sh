#!/usr/bin/env bash
# Start the backend (port 8000) and the frontend dev server (port 5173) together.
# Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

trap 'kill 0' EXIT

(cd backend && uv run uvicorn doc_digest.main:app --reload --port 8000) &
(cd frontend && npm run dev) &

wait
