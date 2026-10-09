import json
import logging
from collections.abc import AsyncIterator
from functools import cache
from typing import Annotated, Any

import anthropic
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .ask import AskRequest, stream_answer
from .config import Settings, get_settings
from .index import Indexer
from .library import Library
from .tools import Toolbox, topic_docs
from .usage import UsageLog

logger = logging.getLogger(__name__)

app = FastAPI(title="doc-digest")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def make_client(settings: Settings) -> anthropic.AsyncAnthropic | None:
    if not settings.anthropic_api_key:
        return None
    return anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)


def get_client(settings: Annotated[Settings, Depends(get_settings)]) -> anthropic.AsyncAnthropic:
    client = make_client(settings)
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="No API key: add ANTHROPIC_API_KEY to backend/.env and restart the backend.",
        )
    return client


class Services:
    """The PDF library, its indexer and the usage log, shared by all requests."""

    def __init__(self, settings: Settings) -> None:
        self.library = Library(settings.data_dir)
        self.answer_model = settings.answer_model
        self.usage = UsageLog(settings.data_dir / "usage.jsonl")
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
def doc_status(doc_id: str, services: ServicesDep) -> dict[str, Any]:
    if services.library.get(doc_id) is None:
        raise HTTPException(status_code=404, detail="No such document.")
    return {"id": doc_id, **services.indexer.doc_status(doc_id)}


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


async def events(
    client: anthropic.AsyncAnthropic, request: AskRequest, services: Services
) -> AsyncIterator[str]:
    """The answer as newline-delimited JSON: text pieces and lookup steps, then done or an error."""
    toolbox = Toolbox(
        services.library, topic_docs(services.library, services.indexer, request.docs)
    )
    try:
        async for event in stream_answer(
            client, request, toolbox, services.usage, request.model or services.answer_model
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
