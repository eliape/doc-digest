import asyncio
import json
import logging
import threading
import time
from collections.abc import AsyncIterator
from functools import cache
from typing import Annotated, Any
from urllib.parse import quote, urlsplit

import anthropic
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import deck as decks
from .anki import package
from .ask import AskRequest, Turn, describe, stream_answer, write_quiz
from .config import Settings, get_settings
from .deck import CardDraft, Decks
from .dedup import SentenceEmbedder
from .flashcards import FlashcardRequest, make_flashcards, sync_vectors
from .flashcards import Services as FlashcardServices
from .index import Indexer
from .library import Library
from .quiz import QuizRecord, reading_so_far, recommend
from .register import (
    TIDY_AFTER,
    DiscussionRequest,
    Registers,
    notes_block,
    notes_for,
    tidy,
    valid_topic_id,
    write_notes,
)
from .saved import SaveConflict, SavedWorkspace
from .title import title_chat
from .tools import Toolbox, topic_docs
from .usage import UsageLog

logger = logging.getLogger(__name__)

app = FastAPI(title="Leqtern")

# The backend runs on the reader's own computer and answers only to pages served from it.
# Checking Host stops a web page from reaching it through a DNS name it points at 127.0.0.1;
# checking Origin stops a page on another site from sending it requests that change things
# (a plain cross-site form or fetch can POST without asking first). "testserver" is the
# Host FastAPI's test client sends.
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "testserver"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def local(netloc: str) -> bool:
    return urlsplit(f"//{netloc}").hostname in LOCAL_HOSTS


@app.middleware("http")
async def only_local_pages(request: Request, call_next):
    host = request.headers.get("host", "")
    if not local(host):
        return JSONResponse({"detail": "Unknown host."}, status_code=403)
    origin = request.headers.get("origin")
    if request.method not in SAFE_METHODS and origin and not local(urlsplit(origin).netloc):
        return JSONResponse(
            {"detail": "Requests from other sites are not allowed."}, status_code=403
        )
    return await call_next(request)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@cache
def _client(api_key: str) -> anthropic.AsyncAnthropic:
    # One client per key, so questions reuse its connections instead of opening new ones.
    return anthropic.AsyncAnthropic(api_key=api_key)


def make_client(settings: Settings) -> anthropic.AsyncAnthropic | None:
    if not settings.anthropic_api_key:
        return None
    return _client(settings.anthropic_api_key)


def get_client(settings: Annotated[Settings, Depends(get_settings)]) -> anthropic.AsyncAnthropic:
    client = make_client(settings)
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="No API key: add ANTHROPIC_API_KEY to backend/.env and restart the backend.",
        )
    return client


class Services:
    """
    The PDF library, its indexer, the usage log, the saved workspace and the topics' registers,
    shared by requests.
    """

    def __init__(self, settings: Settings) -> None:
        self.library = Library(settings.data_dir)
        self.answer_model = settings.answer_model
        self.usage = UsageLog(settings.data_dir / "usage.jsonl")
        self.saved = SavedWorkspace(settings.data_dir / "workspace.json")
        self.registers = Registers(settings.data_dir / "registers")
        self.decks = Decks(settings.data_dir / "decks")
        self.embedder = SentenceEmbedder(settings.embedding_model, settings.embeddings)
        self.indexer = Indexer(self.library, self.usage, lambda: make_client(get_settings()))


@cache
def _services() -> Services:
    return Services(get_settings())


def get_services() -> Services:
    return _services()


ServicesDep = Annotated[Services, Depends(get_services)]


@app.post("/api/docs")
async def add_doc(request: Request, services: ServicesDep, name: str = Query("document.pdf")):
    """Store a PDF (sent as the request body) and start indexing it in the background."""
    # Sent as application/pdf, which a page on another site can't do without asking first.
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/pdf":
        raise HTTPException(status_code=415, detail="Send the PDF as application/pdf.")
    data = await request.body()
    if not data.startswith(b"%PDF"):
        raise HTTPException(status_code=415, detail="That is not a PDF.")
    try:
        doc = await services.library.add(data, name)
    except Exception as error:
        logger.exception("Could not read %s", name)
        raise HTTPException(status_code=422, detail="Could not read this PDF.") from error
    services.indexer.enqueue(doc.id)
    return {"id": doc.id, **services.indexer.doc_status(doc.id)}


@app.get("/api/docs/{doc_id}")
async def doc_status(doc_id: str, services: ServicesDep) -> dict[str, Any]:
    if services.library.get(doc_id) is None:
        raise HTTPException(status_code=404, detail="No such document.")
    services.indexer.resume(doc_id)
    return {"id": doc_id, **services.indexer.doc_status(doc_id)}


@app.post("/api/docs/{doc_id}/index")
async def retry_index(doc_id: str, services: ServicesDep) -> dict[str, Any]:
    """Try indexing a document again after it failed."""
    if services.library.get(doc_id) is None:
        raise HTTPException(status_code=404, detail="No such document.")
    services.indexer.retry(doc_id)
    return {"id": doc_id, **services.indexer.doc_status(doc_id)}


@app.get("/api/docs/{doc_id}/pdf")
def doc_pdf(doc_id: str, services: ServicesDep) -> FileResponse:
    """The PDF itself, for reopening a saved tab."""
    source = services.library.folder(doc_id) / "source.pdf"
    if not doc_id.isalnum() or not source.is_file():
        raise HTTPException(status_code=404, detail="No such document.")
    return FileResponse(source, media_type="application/pdf")


@app.get("/api/workspace")
def load_workspace(services: ServicesDep) -> dict[str, Any]:
    """
    The saved topics, tabs and chats (an empty workspace before anything was saved), with the
    revision to send back with the next save.
    """
    return {**(services.saved.load() or {}), "revision": services.saved.revision()}


# A PDF uploaded this recently is not deleted yet: a tab may have just added it again,
# before saving. The tab asks again with a later save.
KEEP_NEW_SECONDS = 30.0


def saved_doc_ids(workspace: dict[str, Any]) -> set[str]:
    """The backend ids of every PDF in every topic of a saved workspace."""
    ids = set()
    for topic in workspace.get("topics") or []:
        for doc in (topic.get("docs") or []) if isinstance(topic, dict) else []:
            if isinstance(doc, dict) and isinstance(doc.get("serverId"), str):
                ids.add(doc["serverId"])
    return ids


def delete_unused(
    services: Services, workspace: dict[str, Any], ids: list[str]
) -> tuple[list[str], list[str]]:
    """
    Delete the PDFs among `ids` that no topic in the saved workspace has any more, with their
    pages and index, and stop indexing them. A PDF that is in another topic is kept. Returns
    the ids deleted, and those added too recently to delete yet.
    """
    used = saved_doc_ids(workspace)
    deleted, later = [], []
    for doc_id in dict.fromkeys(ids):
        if doc_id in used or not doc_id.isalnum():
            continue
        if time.time() - services.library.added_at.get(doc_id, 0) < KEEP_NEW_SECONDS:
            later.append(doc_id)
            continue
        services.indexer.forget(doc_id)
        try:
            if services.library.remove(doc_id):
                deleted.append(doc_id)
        except OSError:
            logger.exception("Could not delete %s", doc_id)
    return deleted, later


@app.put("/api/workspace")
async def save_workspace(
    workspace: dict[str, Any],
    services: ServicesDep,
    base: int | None = Query(None, description="The revision the tab last loaded or saved"),
    writer: str | None = Query(None, description="An id for the tab, new on each load"),
    release: Annotated[
        list[str] | None, Query(description="PDFs taken out of a topic since the last save")
    ] = None,
) -> dict[str, Any]:
    """
    Save the workspace, then delete the PDFs in `release` (backend ids of PDFs taken out of
    a topic since the last save) that no topic has any more. `later` lists those to send again
    with a later save (see KEEP_NEW_SECONDS).
    """
    workspace.pop("revision", None)
    try:
        revision = services.saved.save(workspace, base, writer)
    except SaveConflict as error:
        raise HTTPException(
            status_code=409, detail="Your topics were saved from another tab since."
        ) from error
    deleted, later = delete_unused(services, workspace, release or [])
    return {"status": "saved", "revision": revision, "deleted": deleted, "later": later}


@app.get("/api/docs/{doc_id}/index")
def doc_index(doc_id: str, services: ServicesDep) -> dict[str, Any]:
    """The document's index as it stands, for inspecting what the model will navigate by."""
    index = services.indexer.get(doc_id)
    if index is None:
        raise HTTPException(status_code=404, detail="Not indexed yet.")
    return json.loads(index.model_dump_json())


@app.get("/api/usage")
def usage(services: ServicesDep) -> dict[str, Any]:
    """Tokens, cache use, latency and cost so far, per kind of model call."""
    return services.usage.summary()


def error_message(error: Exception) -> str:
    if isinstance(error, anthropic.AuthenticationError):
        return "The API key in backend/.env was not accepted."
    if isinstance(error, anthropic.RateLimitError):
        return "Too many requests right now. Try again in a moment."
    if isinstance(error, anthropic.BadRequestError):
        return f"The request was rejected: {error.message}"
    if isinstance(error, anthropic.APIStatusError):
        return f"The model service returned an error ({error.status_code}). Try again."
    if isinstance(error, anthropic.APIConnectionError):
        return "Could not reach the model service. Check your internet connection."
    return "Something went wrong while answering."


async def register_notes(request: AskRequest, services: Services) -> dict[str, Any] | None:
    """
    The topic's notes on earlier discussions for the newest question, when it gets any (see
    notes_for), after waiting for notes still being written about a discussion just left.
    """
    if not request.topic_id or not valid_topic_id(request.topic_id):
        return None
    try:
        register = await services.registers.settled(request.topic_id)
        return notes_block(notes_for(register, request))
    except Exception:
        logger.exception("Could not read the register")
        return None


async def events(
    client: anthropic.AsyncAnthropic, request: AskRequest, services: Services
) -> AsyncIterator[str]:
    """The answer as newline-delimited JSON: text pieces and lookup steps, then done or an error."""
    try:
        toolbox = Toolbox(
            services.library,
            topic_docs(services.library, services.indexer, request.docs, request.doc_names),
        )
        notes = await register_notes(request, services)
        async for event in stream_answer(
            client,
            request,
            toolbox,
            services.usage,
            request.model or services.answer_model,
            notes=notes,
        ):
            yield json.dumps(event) + "\n"
    except Exception as error:
        logger.exception("Answer failed")
        yield json.dumps({"type": "error", "message": error_message(error)}) + "\n"


@app.post("/api/ask")
def ask(
    request: AskRequest,
    client: Annotated[anthropic.AsyncAnthropic, Depends(get_client)],
    services: ServicesDep,
) -> StreamingResponse:
    if not request.messages or request.messages[-1].role != "user":
        raise HTTPException(status_code=422, detail="The last message must be a question.")
    return StreamingResponse(events(client, request, services), media_type="application/x-ndjson")


@app.post("/api/quiz")
async def quiz(
    request: AskRequest,
    client: Annotated[anthropic.AsyncAnthropic, Depends(get_client)],
    services: ServicesDep,
) -> dict[str, Any]:
    """
    A multiple-choice quiz for the newest turn, which asks for one. Without anything to focus
    on, it covers the section being read, up to where the reader is.
    """
    last = request.messages[-1] if request.messages else None
    if not last or last.mode != "quiz":
        raise HTTPException(status_code=422, detail="The last message must ask for a quiz.")
    try:
        reading = []
        if not last.text.strip() and last.context and last.context.doc_id:
            doc_id = last.context.doc_id
            ids = request.docs if doc_id in request.docs else [*request.docs, doc_id]
            toolbox = Toolbox(
                services.library,
                topic_docs(services.library, services.indexer, ids, request.doc_names),
            )
            reading = await reading_so_far(toolbox, doc_id, last.context.page)
        notes = await register_notes(request, services)
        written = await write_quiz(
            client,
            request,
            services.usage,
            request.model or services.answer_model,
            reading,
            notes=notes,
        )
    except Exception as error:
        logger.exception("Quiz failed")
        raise HTTPException(status_code=502, detail=error_message(error)) from error
    return written.model_dump()


class RecommendRequest(BaseModel):
    topic: str
    about: Turn
    quiz: QuizRecord


@app.post("/api/quiz/recommendation")
async def quiz_recommendation(
    request: RecommendRequest,
    client: Annotated[anthropic.AsyncAnthropic, Depends(get_client)],
    services: ServicesDep,
) -> dict[str, str | None]:
    """What to review after a quiz, or no text when every answer was right."""
    about = request.about
    asked = describe(about.context) if about.context else ""
    if about.text.strip():
        asked += f" They asked the quiz to focus on: {about.text.strip()}"
    elif about.context:
        asked += " The quiz covered the section they were reading, up to there."
    try:
        text = await recommend(client, request.topic, asked, request.quiz, services.usage)
    except Exception as error:
        logger.exception("Recommendation failed")
        raise HTTPException(status_code=502, detail=error_message(error)) from error
    return {"text": text}


class TitleRequest(BaseModel):
    topic: str
    about: Turn


@app.post("/api/chat-title")
async def chat_title(
    request: TitleRequest,
    client: Annotated[anthropic.AsyncAnthropic, Depends(get_client)],
    services: ServicesDep,
) -> dict[str, str | None]:
    """A few words naming a discussion, from its first question."""
    about = request.about
    asked = describe(about.context) if about.context else ""
    if about.mode == "quiz":
        asked += " They asked for a quiz"
        asked += f" on: {about.text.strip()}" if about.text.strip() else "."
    elif about.mode == "socratic":
        asked += " They asked to be guided by questions"
        asked += f" about: {about.text.strip()}" if about.text.strip() else "."
    else:
        asked += f" They ask: {about.text.strip()}"
    try:
        text = await title_chat(client, request.topic, asked.strip(), services.usage)
    except Exception as error:
        logger.exception("Title failed")
        raise HTTPException(status_code=502, detail=error_message(error)) from error
    return {"text": text}


def topic_register_id(topic_id: str) -> str:
    if not valid_topic_id(topic_id):
        raise HTTPException(status_code=422, detail="Not a topic id.")
    return topic_id


@app.post("/api/topics/{topic_id}/register")
async def note_discussion(
    topic_id: str,
    request: DiscussionRequest,
    client: Annotated[anthropic.AsyncAnthropic, Depends(get_client)],
    services: ServicesDep,
) -> dict[str, int]:
    """
    Note what is new in a discussion the reader left in the topic's register, and tidy the
    register once enough has changed since the last tidy (keeping a copy from before it).
    Questions asked meanwhile in the topic wait for the notes (not the tidy), so a new
    discussion starts with them.
    """
    topic_register_id(topic_id)
    registers = services.registers
    async with registers.lock(topic_id):
        names = {}
        for doc_id in request.docs:
            info = services.library.get(doc_id)
            if info:
                names[request.doc_names.get(doc_id) or info.name] = doc_id
        async with registers.noting(topic_id):
            register = registers.load(topic_id)
            try:
                changed = await write_notes(client, register, request, names, services.usage)
            except Exception as error:
                logger.exception("Noting the discussion failed")
                raise HTTPException(status_code=502, detail=error_message(error)) from error
            registers.save(topic_id, register)
        if changed and register.pending() >= TIDY_AFTER:
            try:
                registers.backup(topic_id)
                await tidy(client, register, request.topic, names, services.usage)
                registers.save(topic_id, register)
            except Exception:
                # The new notes are saved; the tidy is tried again after the next ones.
                logger.exception("Tidying the register failed")
    return {"changed": changed, "notes": len(register.notes)}


@app.get("/api/topics/{topic_id}/register")
def topic_register(topic_id: str, services: ServicesDep) -> dict[str, Any]:
    """The topic's notes, oldest first."""
    register = services.registers.load(topic_register_id(topic_id))
    return {"notes": [n.model_dump() for n in register.notes]}


@app.delete("/api/topics/{topic_id}/register")
async def forget_topic(topic_id: str, services: ServicesDep) -> dict[str, str]:
    """Delete a topic's register, when the topic is deleted, after notes still being written."""
    topic_register_id(topic_id)
    async with services.registers.lock(topic_id):
        services.registers.delete(topic_id)
    return {"status": "deleted"}


# ---- Flashcards ----


def deck_view(deck: decks.Deck) -> dict[str, Any]:
    return {
        "cards": [c.model_dump() for c in deck.cards],
        "deleted": [d.model_dump() for d in deck.deleted],
        "changes": deck.changes(),
        "exported_at": deck.exported_at,
    }


def warm_embeddings(services: Services) -> None:
    """Load the embedding model in the background, so it is ready when cards are made."""
    threading.Thread(target=services.embedder.available, daemon=True).start()


@app.get("/api/topics/{topic_id}/deck")
def topic_deck(topic_id: str, services: ServicesDep) -> dict[str, Any]:
    """The topic's flashcards and what changed since they were last exported."""
    deck = services.decks.load(topic_register_id(topic_id))
    warm_embeddings(services)
    return deck_view(deck)


async def flashcard_events(
    client: anthropic.AsyncAnthropic, request: FlashcardRequest, services: Services
) -> AsyncIterator[str]:
    """Making cards as newline-delimited JSON: lookup steps, then the result or an error."""
    ids = list(request.docs)
    doc_id = request.context.doc_id if request.context else None
    if doc_id and doc_id not in ids:
        ids.append(doc_id)
    toolbox = Toolbox(
        services.library, topic_docs(services.library, services.indexer, ids, request.doc_names)
    )
    try:
        register = await services.registers.settled(request.topic_id)
        async for event in make_flashcards(
            client,
            request,
            toolbox,
            register,
            FlashcardServices(services.decks, services.embedder, services.usage),
            request.model or services.answer_model,
        ):
            yield json.dumps(event) + "\n"
    except Exception as error:
        logger.exception("Making flashcards failed")
        message = str(error) if isinstance(error, RuntimeError) else error_message(error)
        yield json.dumps({"type": "error", "message": message}) + "\n"


@app.post("/api/topics/{topic_id}/flashcards")
def make_cards(
    topic_id: str,
    request: FlashcardRequest,
    client: Annotated[anthropic.AsyncAnthropic, Depends(get_client)],
    services: ServicesDep,
) -> StreamingResponse:
    """Write flashcards from a spot in a PDF or a discussion, for the reader to preview."""
    if topic_register_id(topic_id) != request.topic_id:
        raise HTTPException(status_code=422, detail="The topic ids don't match.")
    if not request.context and not request.messages:
        raise HTTPException(status_code=422, detail="Nothing to make cards from.")
    return StreamingResponse(
        flashcard_events(client, request, services), media_type="application/x-ndjson"
    )


class AddCards(BaseModel):
    cards: list[CardDraft]
    # Basic cards to turn into Basic and reversed, for new cards that were their reverse.
    upgrades: list[str] = []


async def refresh_vectors(services: Services, topic_id: str, deck: decks.Deck) -> None:
    """Bring the deck's embeddings up to date, when the model is loaded; else the next use does."""
    if not services.embedder.ready():
        return
    try:
        await asyncio.to_thread(sync_vectors, services.decks, topic_id, deck, services.embedder)
    except Exception:
        logger.exception("Could not update the deck's embeddings")


@app.post("/api/topics/{topic_id}/deck/cards")
async def add_cards(topic_id: str, request: AddCards, services: ServicesDep) -> dict[str, Any]:
    """Add the cards approved in the preview, and turn the cards named in `upgrades` two-way."""
    topic_register_id(topic_id)
    async with services.decks.lock(topic_id):
        deck = services.decks.load(topic_id)
        added = [decks.new_card(d) for d in request.cards]
        deck.cards.extend(added)
        for card_id in request.upgrades:
            card = deck.get(card_id)
            if card and card.type == "basic":
                decks.edit(deck, card_id, card.model_copy(update={"type": "basic_reversed"}))
        services.decks.save(topic_id, deck)
    await refresh_vectors(services, topic_id, deck)
    return {"added": [c.id for c in added], **deck_view(deck)}


@app.patch("/api/topics/{topic_id}/deck/cards/{card_id}")
async def edit_card(
    topic_id: str, card_id: str, changes: CardDraft, services: ServicesDep
) -> dict[str, Any]:
    topic_register_id(topic_id)
    async with services.decks.lock(topic_id):
        deck = services.decks.load(topic_id)
        try:
            card = decks.edit(deck, card_id, changes)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="No such card.") from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        services.decks.save(topic_id, deck)
    await refresh_vectors(services, topic_id, deck)
    return {"card": card.model_dump(), **deck_view(deck)}


@app.delete("/api/topics/{topic_id}/deck/cards/{card_id}")
async def delete_card(topic_id: str, card_id: str, services: ServicesDep) -> dict[str, Any]:
    topic_register_id(topic_id)
    async with services.decks.lock(topic_id):
        deck = services.decks.load(topic_id)
        if not decks.delete(deck, card_id):
            raise HTTPException(status_code=404, detail="No such card.")
        services.decks.save(topic_id, deck)
    return deck_view(deck)


class ExportRequest(BaseModel):
    name: str


@app.post("/api/topics/{topic_id}/deck/export")
async def export_deck(topic_id: str, request: ExportRequest, services: ServicesDep) -> Response:
    """The deck as an Anki package. Its cards then count as exported."""
    topic_register_id(topic_id)
    async with services.decks.lock(topic_id):
        deck = services.decks.load(topic_id)
        if not deck.cards:
            raise HTTPException(status_code=422, detail="The deck has no cards yet.")
        data = await asyncio.to_thread(package, topic_id, request.name, deck)
        decks.mark_exported(deck)
        services.decks.save(topic_id, deck)
    filename = f"Leqtern - {request.name.strip() or 'Topic'}.apkg"
    safe = "".join(ch if ch.isascii() and ch not in '"\\' else "_" for ch in filename)
    return Response(
        data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{safe}"; '
            f"filename*=UTF-8''{quote(filename)}"
        },
    )


@app.delete("/api/topics/{topic_id}/deck")
def forget_deck(topic_id: str, services: ServicesDep) -> dict[str, str]:
    """Delete a topic's deck, when the topic is deleted."""
    services.decks.delete(topic_register_id(topic_id))
    return {"status": "deleted"}
