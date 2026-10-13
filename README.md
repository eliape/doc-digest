# Leqtern

A PDF reader for learning. Open a document, point at a passage, figure or equation, and ask about it. Answers know exactly where you are in the document and cite pages you can click to jump back to.

It runs locally: a Svelte web app in your browser and a small Python service that holds your API key. A Mac app comes later.

The v1 plan, scope and build order are in [docs/v1-scope.md](docs/v1-scope.md).

## What it does

- **Topics with PDF tabs.** The sidebar holds your topics; each topic keeps several PDFs as tabs and has one chat. Every PDF in the topic counts as context, and citations name the PDF and page.
- **Two cursor tools** in the PDF toolbar, remembered per topic. *Select* works like any PDF reader. *Click to ask* attaches whatever you click or select to the chat, sent as an image so scans and equations work.
- **Right-click** a spot or selection for *Ask*, *Socratic* or *Quiz me*. Each attaches it and opens the chat so you can say what to focus on.
- **Three modes**, picked under the question box: *Normal* answers, *Socratic* asks you leading questions instead of explaining, and *Quiz* writes a multiple-choice quiz you click through. The quiz ends with your results and, if there is room to improve, a short tip on what to review. Later answers and quizzes build on those results.
- **Model menu** under the question box: Claude Opus 5.5 or the cheaper Claude Sonnet 5.5 (about half the cost per question). The browser remembers it.
- **Document index.** Each PDF you add is indexed in the background by a cheap model. Answers use it to search, browse the outline and read pages across the whole topic, not just the page you are on.
- **What you've done before.** When you leave a discussion, a cheap model notes what you worked on, solved, struggled with and understood in it, in the topic's register (`backend/data/registers/`). A new discussion's first question, and any question about a spot you point at, gets the few notes that fit it, so the answer can skip pitfalls you already got past, refer back to how you solved something, and point out what you struggled with before.
- **Outline.** The square button left of the tabs shows the PDF's bookmarks, or the index's sections when it has none, with the current section highlighted. Click an entry to jump to that heading.
- **Saved to disk.** Topics, tabs (with the last page), chats, modes and models are saved in `backend/data/workspace.json`, and the PDFs and their indexes in `backend/data/docs/`, so everything is back after a reload or restart.

## Layout

- `frontend/`: Svelte + TypeScript + Vite single-page app with a PDF.js viewer (its legacy build, which works in Chromium and WebKit). Tests use Vitest and Testing Library.
- `backend/`: Python FastAPI service, managed with [uv](https://docs.astral.sh/uv/). It answers questions, and keeps and indexes the PDFs you add under `backend/data/`. Tests use pytest; lint and format with ruff.
- `docs/`: plans and design notes.

## Getting started

You need Node 22+, Python 3.12+ and uv.

```sh
make install                          # install backend and frontend dependencies
cp backend/.env.example backend/.env  # then add your ANTHROPIC_API_KEY
make dev                              # backend on :8000, frontend on http://localhost:5173
```

The frontend dev server forwards `/api/*` to the backend, so open http://localhost:5173.

### Reindexing

To index PDFs again (for example after the indexing prompt changes), delete only the index files, then restart `make dev` and reload the page. Open tabs queue their PDFs for indexing again.

```sh
rm backend/data/docs/*/index.json
```

Don't delete the folders in `backend/data/docs/`: they also hold the PDFs your saved tabs open from.

## Checking retrieval and cost

To check how well the document index finds the right pages, and what it costs, write a few questions with known answer pages (format in [evaluate.py](backend/src/leqtern/evaluate.py)) and run:

```sh
cd backend
uv run python -m leqtern.evaluate questions.json book.pdf scanned-book.pdf paper.pdf
```

`GET /api/usage` shows tokens, cache use, latency and cost of every model call so far.

`make costs` sums up what the API has cost from that log: per question (straight answers and those with lookups), per quiz, for indexing each PDF, and per day. Narrow it with `make costs ARGS="--since 2026-10-10"` or `ARGS="--days 1"`.

The evaluation above uses `ANSWER_MODEL` from `backend/.env` instead of the model menu (default `claude-opus-5-5`), so set `ANSWER_MODEL=claude-sonnet-5-5` and run it again to compare.

## Tests and checks

```sh
make test   # pytest + vitest
make check  # ruff + svelte-check/tsc
```

CI runs the same on every pull request.
