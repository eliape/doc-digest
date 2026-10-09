# doc-digest v1: what the first version should contain

## Step 1. Who it is for, and the one job it does

A learner works through a PDF, such as a textbook chapter, a paper or lecture slides, often with a second source open beside it, and gets stuck on a passage. Today they copy the text into a chat, lose the surrounding context and get a generic answer.

v1 does one job well: **while reading, point at something and get an explanation that knows exactly where you are in the document.** Everything else is secondary.

## Step 2. What "always the correct context" means

This is the product's edge, so it needs a precise definition. PDFs are grouped into **topics** (see Step 3), and a topic is the unit of context. Each question should carry five layers of context, from most to least specific:

1. **What you pointed at:** the spot you clicked or the text you selected, sent as an image of that area plus any text the PDF has there (see Step 3b).
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

Open PDF (as a tab in a topic) → read → click on the thing you are stuck on (or select text) → the chat opens with that spot attached as context → type your question → a streaming answer appears in the side panel → citations jump back into the PDF.

## Step 3b. Click to ask: how a question reaches the model

### The interaction

A **plain left click on page content** attaches what is under it to the chat. A drag still selects text as before, and a selection attaches exactly that text when you release the mouse.

1. You click an equation. A marker appears at the spot, and the chat opens with the composer focused.
2. Above the composer sits a **context chip**: a small thumbnail of the clicked area and "p. 12", plus the first words of the text there when the PDF has any.
3. You type the question and press Enter. The question and the attached context are sent together, and the chip moves onto the sent message.

The app does not write the question for you; that may come later. Nothing is sent to the model until you send.

Rules that keep clicks from getting in the way:
- A click is a mouse-down and mouse-up within a few pixels and no text selected. Clicks on PDF links, on margins (no content near the point) and the click that only focuses the window do nothing.
- **Whatever is already in the composer stays as it is.** A click only changes the attached context.
- A new click replaces the attached context; there is one at a time.
- Esc, the chip's × or clicking the marker removes the attached context, and a question sent without one uses only the open page as context.

### The metadata: where it came from

Each click or selection produces an **anchor**, which is computed instantly in the browser and saved on the chat message:
- **Document:** the tab's PDF id and file name, plus a hash of its bytes so caching and persistence keys stay stable.
- **Page:** the page number and the printed page label (PDF.js `getPageLabels`, so "xii" or "214" match what the reader sees).
- **Position:** the click point, or the selection's boxes, in page coordinates normalized to 0 to 1, so it does not depend on zoom.
- **Section:** the nearest preceding heading from the PDF's outline (`getOutline`), when the PDF has one.
- **Text hints:** the text-layer line under the point and the surrounding paragraph, or the selected text. Scanned pages have none, and that is fine.

The anchor shows as the context chip, and on the sent message. Clicking it switches to the tab, jumps to the page and flashes the spot, the same way citations do.

### The content: looking, not just reading text

The **image is the source of truth**, and the PDF's text is a hint. Scanned pages, equations (whose text layer is usually garbled), figures and tables all work the same way, and we never run our own OCR.

For each click or selection the browser renders, with PDF.js at a fixed resolution independent of zoom:
- a **crop** around the point, large enough to hold a whole equation or figure, with the click point marked, and
- the **whole page** at a moderate resolution, so the model sees what the crop belongs to.

**Answer** (`POST /api/ask`, streaming) sends the model the question, the anchor as structured text, the crop and page images, and the text of the surrounding pages. From build step 3 it also gets the whole PDF as a document block with prompt caching, which already includes every page as an image, so scanned books get full context too. Citations come back as PDF and page.

## Step 3c. Why a click and not a box

A click plus the model's vision covers what box-select was for: the model sees the crop and the page and can tell that the click was on Figure 2 or on the right-hand side of equation 3.4. A drag-to-box tool stays out of v1 and comes back only if clicks prove too imprecise in practice.

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
- Click on anything (text, equation, figure, scanned page) or select text to attach it as context, then type the question
- Whole-document and whole-topic context, with clickable citations to a PDF and page
- Topics, their PDFs and each topic's chat history saved, so they are still there after a reload

**Out (later versions):**
- Quizzes, flashcards and spaced repetition (the natural v2 for learning)
- Saved highlights and notes, and exporting them
- Search across all topics, and sharing one stored PDF between topics
- Generated questions for a clicked spot
- Box-select of a region, unless clicks prove too imprecise
- Accounts, sync, hosting and mobile
- The Mac app

## Step 6. Build order

1. **Viewer:** open a PDF, render pages, text layer, navigation, zoom.
   - **Topics:** collapsible sidebar of topics, with PDFs as tabs. Kept in memory until step 4.
2. **Ask:** in two pieces, each usable on its own.
   - **2a. Answers:** typed question → `/api/ask` → streaming answer in the chat, with the current page's image and the surrounding pages' text as context.
   - **2b. Click to ask:** click or selection → anchor, marker, crop and page images, context chip; the chip on sent messages jumps back.
3. **Whole document and topic:** cached full-PDF context for the open tab, then the topic's other PDFs, with citations that switch tab and jump.
4. **Persistence:** topics, their PDFs and each topic's chat history (with anchors) in IndexedDB.
5. **Long documents:** retrieval fallback when the PDF exceeds the model's limits.

Each step works on its own, so steps 1 and 2 already give a usable tool.

## Step 7. How we know v1 works

Open a long textbook, select a paragraph deep in it and ask "what does this mean?" The answer should explain that paragraph and use a definition from an earlier chapter. It should cite the right page, and clicking the citation should land there. The answer should start streaming within a couple of seconds.
