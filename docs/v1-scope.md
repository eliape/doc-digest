# doc-digest v1: what the first version should contain

## Step 1. Who it is for, and the one job it does

A learner works through one PDF, such as a textbook chapter, a paper or lecture slides, and gets stuck on a passage. Today they copy the text into a chat, lose the surrounding context and get a generic answer.

v1 does one job well: **while reading, point at something and get an explanation that knows exactly where you are in the document.** Everything else is secondary.

## Step 2. What "always the correct context" means

This is the product's edge, so it needs a precise definition. Each question should carry four layers of context, from most to least specific:

1. **What you pointed at:** the selected text, or a dragged box around a figure or equation.
2. **Where you are:** the page number plus the surrounding pages' text.
3. **The whole document:** so the model can resolve "as defined in chapter 2" or a symbol introduced earlier.
4. **The conversation so far** about this document.

Answers must **cite page numbers that you can click to jump to**. That makes the answers checkable, and checking matters for learning.

How the whole-document layer works depends on the document's size:
- **Documents that fit the model's limits:** send the whole PDF with prompt caching, so follow-up questions are cheap and fast. Claude reads PDFs natively, including the page images, so figures and scanned pages work too.
- **Long books:** fall back to the current page window plus retrieval (search over page text) for the rest. Build this after the first path works. Check the API's current page and size limits when implementing.

## Step 3. The core loop

Open PDF → read → select text (or box a region) → choose a quick action or type a question → a streaming answer appears in a side panel → citations jump back into the PDF.

The quick actions on a selection are **Explain**, **Explain simpler** and **Give an example**. They cover most learning questions with one click.

## Step 4. Architecture that survives the move to Mac

- **Frontend: Svelte + TypeScript + Vite + PDF.js** (Mozilla's PDF renderer, the same one Firefox uses). It is a plain single-page app rather than SvelteKit, because the Python backend serves the API and a single-page app is the easiest to wrap for Mac. It provides rendering, a selectable text layer and per-page text extraction. The viewer and chat panel live here.
- **Backend: a small Python (FastAPI) service.** It holds the API key and builds the context. It also handles model calls and streaming. Python fits the repo's existing `.gitignore`.
- **Mac later:** wrap the same frontend in a desktop shell (Tauri or Electron) and keep the backend logic behind the same small API. Nothing in v1 should assume a browser-only feature that has no desktop equivalent.
- **Storage: local only.** Store PDFs and per-document chat history in the browser (IndexedDB). No accounts and no sync.

Defaults I picked (easy to change): Python backend rather than Node, and v1 runs locally on your machine with the API key in a local `.env` file, not hosted publicly.

## Step 5. v1 scope

**In:**
- Open a local PDF, with page navigation, zoom and text selection
- Side panel chat with streaming answers
- Ask about a selection, with quick actions or a free-form question
- Box-select a region (figure, equation, table) and ask about it
- Whole-document context, with clickable page citations
- Chat history saved per document, so it is still there when you reopen the PDF

**Out (later versions):**
- Quizzes, flashcards and spaced repetition (the natural v2 for learning)
- Saved highlights and notes, and exporting them
- A library of many documents and search across them
- Accounts, sync, hosting and mobile
- The Mac app

## Step 6. Build order

1. **Viewer:** open a PDF, render pages, text layer, navigation, zoom.
2. **Ask:** selection → side panel → backend → streaming answer, using page-window context.
3. **Whole document:** cached full-PDF context, with page citations that jump.
4. **Regions:** box-select → cropped page image sent with the question.
5. **Persistence:** chat history per document in IndexedDB.
6. **Long documents:** retrieval fallback when the PDF exceeds the model's limits.

Each step works on its own, so steps 1 and 2 already give a usable tool.

## Step 7. How we know v1 works

Open a long textbook, select a paragraph deep in it and ask "what does this mean?" The answer should explain that paragraph and use a definition from an earlier chapter. It should cite the right page, and clicking the citation should land there. The answer should start streaming within a couple of seconds.
