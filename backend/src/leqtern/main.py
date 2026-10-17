import json
import logging
from collections.abc import AsyncIterator
from functools import cache
from typing import Annotated, Any
from urllib.parse import urlsplit

import anthropic
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from .ask import AskRequest, Turn, describe, stream_answer, write_quiz
from .config import Settings, get_settings
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


@app.put("/api/workspace")
def save_workspace(
    workspace: dict[str, Any],
    services: ServicesDep,
    base: int | None = Query(None, description="The revision the tab last loaded or saved"),
    writer: str | None = Query(None, description="An id for the tab, new on each load"),
) -> dict[str, Any]:
    workspace.pop("revision", None)
    try:
        revision = services.saved.save(workspace, base, writer)
    except SaveConflict as error:
        raise HTTPException(
            status_code=409, detail="Your topics were saved from another tab since."
        ) from error
    return {"status": "saved", "revision": revision}


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
