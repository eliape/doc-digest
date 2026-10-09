import json
import logging
from collections.abc import AsyncIterator
from typing import Annotated

import anthropic
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from .ask import AskRequest, stream_answer
from .config import Settings, get_settings

logger = logging.getLogger(__name__)

app = FastAPI(title="doc-digest")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def get_client(settings: Annotated[Settings, Depends(get_settings)]) -> anthropic.AsyncAnthropic:
    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=503,
            detail="No API key: add ANTHROPIC_API_KEY to backend/.env and restart the backend.",
        )
    return anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)


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


async def events(client: anthropic.AsyncAnthropic, request: AskRequest) -> AsyncIterator[str]:
    """The answer as newline-delimited JSON: text pieces, then done or an error."""
    try:
        async for text in stream_answer(client, request):
            yield json.dumps({"type": "text", "text": text}) + "\n"
    except Exception as error:
        logger.exception("Answer failed")
        yield json.dumps({"type": "error", "message": error_message(error)}) + "\n"
        return
    yield json.dumps({"type": "done"}) + "\n"


@app.post("/api/ask")
def ask(
    request: AskRequest,
    client: Annotated[anthropic.AsyncAnthropic, Depends(get_client)],
) -> StreamingResponse:
    if not request.messages or request.messages[-1].role != "user":
        raise HTTPException(status_code=422, detail="The last message must be a question.")
    return StreamingResponse(events(client, request), media_type="application/x-ndjson")
