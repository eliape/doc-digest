import json
import logging
from collections.abc import AsyncIterator
from functools import cache
from typing import Annotated, Any

import anthropic
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from .ask import AskRequest, Turn, describe, stream_answer, write_quiz
from .config import Settings, get_settings
from .index import Indexer
from .library import Library
from .quiz import QuizRecord, reading_so_far, recommend
from .register import (
    DiscussionRequest,
    Registers,
    notes_block,
    pick,
    valid_topic_id,
    wants_notes,
    write_notes,
)
from .saved import SavedWorkspace
from .title import title_chat
from .tools import Toolbox, topic_docs
from .usage import UsageLog

logger = logging.getLogger(__name__)

app = FastAPI(title="Leqtern")


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


@app.get("/api/docs/{doc_id}/pdf")
def doc_pdf(doc_id: str, services: ServicesDep) -> FileResponse:
    """The PDF itself, for reopening a saved tab."""
    source = services.library.folder(doc_id) / "source.pdf"
    if not doc_id.isalnum() or not source.is_file():
        raise HTTPException(status_code=404, detail="No such document.")
    return FileResponse(source, media_type="application/pdf")


@app.get("/api/workspace")
def load_workspace(services: ServicesDep) -> dict[str, Any]:
    """The saved topics, tabs and chats, or an empty object before anything was saved."""
    return services.saved.load() or {}


@app.put("/api/workspace")
def save_workspace(workspace: dict[str, Any], services: ServicesDep) -> dict[str, str]:
    services.saved.save(workspace)
    return {"status": "saved"}


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
    wants_notes), after waiting for notes still being written about a discussion just left.
    """
    if not request.topic_id or not valid_topic_id(request.topic_id) or not wants_notes(request):
        return None
    try:
        register = await services.registers.settled(request.topic_id)
        return notes_block(pick(register, request.messages[-1], request.chat_id))
    except Exception:
        logger.exception("Could not read the register")
        return None


async def events(
    client: anthropic.AsyncAnthropic, request: AskRequest, services: Services
) -> AsyncIterator[str]:
    """The answer as newline-delimited JSON: text pieces and lookup steps, then done or an error."""
    toolbox = Toolbox(
        services.library,
        topic_docs(services.library, services.indexer, request.docs, request.doc_names),
    )
    try:
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
    Note what is new in a discussion the reader left in the topic's register. Questions asked
    meanwhile in the topic wait for it, so a new discussion starts with these notes.
    """
    topic_register_id(topic_id)
    registers = services.registers
    async with registers.lock(topic_id):
        register = registers.load(topic_id)
        names = {}
        for doc_id in request.docs:
            info = services.library.get(doc_id)
            if info:
                names[request.doc_names.get(doc_id) or info.name] = doc_id
        try:
            changed = await write_notes(client, register, request, names, services.usage)
        except Exception as error:
            logger.exception("Noting the discussion failed")
            raise HTTPException(status_code=502, detail=error_message(error)) from error
        registers.save(topic_id, register)
    return {"changed": changed, "notes": len(register.notes)}


@app.get("/api/topics/{topic_id}/register")
def topic_register(topic_id: str, services: ServicesDep) -> dict[str, Any]:
    """The topic's notes, oldest first."""
    register = services.registers.load(topic_register_id(topic_id))
    return {"notes": [n.model_dump() for n in register.notes]}


@app.delete("/api/topics/{topic_id}/register")
def forget_topic(topic_id: str, services: ServicesDep) -> dict[str, str]:
    """Delete a topic's register, when the topic is deleted."""
    services.registers.delete(topic_register_id(topic_id))
    return {"status": "deleted"}
