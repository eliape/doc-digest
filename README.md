# doc-digest

A PDF reader for learning. Open a document, point at a passage, figure or equation, and ask about it. Answers know exactly where you are in the document and cite pages you can click to jump back to.

It runs locally: a Svelte web app in your browser and a small Python service that holds your API key. A Mac app comes later.

The v1 plan, scope and build order are in [docs/v1-scope.md](docs/v1-scope.md).

## Layout

- `frontend/`: Svelte + TypeScript + Vite single-page app (PDF.js arrives with the viewer step). Tests use Vitest and Testing Library.
- `backend/`: Python FastAPI service, managed with [uv](https://docs.astral.sh/uv/). Tests use pytest; lint and format with ruff.
- `docs/`: plans and design notes.

## Getting started

You need Node 22+, Python 3.12+ and uv.

```sh
make install                          # install backend and frontend dependencies
cp backend/.env.example backend/.env  # then add your ANTHROPIC_API_KEY
make dev                              # backend on :8000, frontend on http://localhost:5173
```

The frontend dev server forwards `/api/*` to the backend, so open http://localhost:5173. The page shows whether it can reach the backend.

## Checking retrieval and cost

Each PDF you add is indexed in the background with a cheap model, and answers look things up across the topic. To check how well that finds the right pages, and what it costs, write a few questions with known answer pages (format in [evaluate.py](backend/src/doc_digest/evaluate.py)) and run:

```sh
cd backend
uv run python -m doc_digest.evaluate questions.json book.pdf scanned-book.pdf paper.pdf
```

`GET /api/usage` shows tokens, cache use, latency and cost of every model call so far.

## Tests and checks

```sh
make test   # pytest + vitest
make check  # ruff + svelte-check/tsc
```

CI runs the same on every pull request.
