# doc-digest v1: what the first version should contain

## Step 1. Who it is for, and the one job it does

A learner works through a PDF, such as a textbook chapter, a paper or lecture slides, often with a second source open beside it, and gets stuck on a passage. Today they copy the text into a chat, lose the surrounding context and get a generic answer.

v1 does one job well: **while reading, point at something and get an explanation that knows exactly where you are in the document.** Everything else is secondary.

## Step 2. What "always the correct context" means

This is the product's edge, so it needs a precise definition. PDFs are grouped into **topics** (see Step 3), and a topic is the unit of context. Each question should carry five layers of context, from most to least specific:

1. **What you pointed at:** the selected text, or a dragged box around a figure or equation.
2. **Where you are:** the open tab's PDF, the page number and the surrounding pages' text.
3. **The whole document:** so the model can resolve "as defined in chapter 2" or a symbol introduced earlier.
4. **The topic's other PDFs:** so "how does the course book explain this slide?" works. They rank below the open document.
5. **The conversation so far** in this topic. There is one chat per topic, not per PDF.

Answers must **cite the PDF and page number, and you can click a citation to switch to that tab and jump to the page**. That makes the answers checkable, and checking matters for learning.

How the whole-document layer works depends on the document's size:
- **Documents that fit the model's limits:** send the whole PDF with prompt caching, so follow-up questions are cheap and fast. Claude reads PDFs natively, including the page images, so figures and scanned pages work too.
- **Long books:** fall back to the current page window plus retrieval (search over page text) for the rest. Build this after the first path works. Check the API's current page and size limits when implementing.
- **Topics with several PDFs** reach those limits sooner, since every PDF in the topic counts. Send the open document whole when it fits and use retrieval for the others first.

## Step 3. The core loop

A collapsible sidebar lists **topics**, like the conversation list in a chat app. A topic collects the PDFs studied together, such as lecture notes and the course book, and each one opens as a tab in that topic. Opening a PDF with no topic selected starts a topic named after the file.

Open PDF (as a tab in a topic) → read → select text (or box a region) → choose a quick action or type a question → a streaming answer appears in a side panel → citations jump back into the PDF.

The quick actions on a selection are **Explain**, **Explain simpler** and **Give an example**. They cover most learning questions with one click.

## Step 4. Architecture that survives the move to Mac

- **Frontend: Svelte + TypeScript + Vite + PDF.js** (Mozilla's PDF renderer, the same one Firefox uses). It is a plain single-page app rather than SvelteKit, because the Python backend serves the API and a single-page app is the easiest to wrap for Mac. It provides rendering, a selectable text layer and per-page text extraction. The viewer and chat panel live here.
- **Backend: a small Python (FastAPI) service.** It holds the API key and builds the context. It also handles model calls and streaming. Python fits the repo's existing `.gitignore`.
- **Mac later:** wrap the same frontend in a desktop shell (Tauri or Electron) and keep the backend logic behind the same small API. Nothing in v1 should assume a browser-only feature that has no desktop equivalent.
- **Storage: local only.** Store topics, their PDFs and each topic's chat history in the browser (IndexedDB). No accounts and no sync.

Defaults I picked (easy to change): Python backend rather than Node, and v1 runs locally on your machine with the API key in a local `.env` file, not hosted publicly.

## Step 5. v1 scope

**In:**
- Open a local PDF, with page navigation, zoom and text selection
- A collapsible topics sidebar, with each topic's PDFs as tabs that keep their place
- Side panel chat with streaming answers
- Ask about a selection, with quick actions or a free-form question
- Box-select a region (figure, equation, table) and ask about it
- Whole-document and whole-topic context, with clickable citations to a PDF and page
- Topics, their PDFs and each topic's chat history saved, so they are still there after a reload

**Out (later versions):**
- Quizzes, flashcards and spaced repetition (the natural v2 for learning)
- Saved highlights and notes, and exporting them
- Search across all topics, and sharing one stored PDF between topics
- Accounts, sync, hosting and mobile
- The Mac app

## Step 6. Build order

1. **Viewer:** open a PDF, render pages, text layer, navigation, zoom.
   - **Topics:** collapsible sidebar of topics, with PDFs as tabs. Kept in memory until step 5.
2. **Ask:** selection → side panel → backend → streaming answer, using page-window context. One chat per topic.
3. **Whole document and topic:** cached full-PDF context for the open tab, then the topic's other PDFs, with citations that switch tab and jump.
4. **Regions:** box-select → cropped page image sent with the question.
5. **Persistence:** topics, their PDFs and each topic's chat history in IndexedDB.
6. **Long documents:** retrieval fallback when the PDF exceeds the model's limits.

Each step works on its own, so steps 1 and 2 already give a usable tool.

## Step 7. How we know v1 works

Open a long textbook, select a paragraph deep in it and ask "what does this mean?" The answer should explain that paragraph and use a definition from an earlier chapter. It should cite the right page, and clicking the citation should land there. The answer should start streaming within a couple of seconds.
