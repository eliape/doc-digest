"""Turn a question and what the reader pointed at into a model request, and stream the answer."""

from collections.abc import AsyncIterator
from typing import Any, Literal

from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field

MODEL = "claude-opus-5-5"

SYSTEM_PROMPT = """\
You help someone learn from PDFs they are studying, such as textbooks, papers and lecture \
slides. They read in a viewer next to this chat and ask about what they are reading.

With a question you may get:
- the whole page they are on, as an image;
- a close-up of the spot they clicked or the text they selected, with that spot marked in red;
- text extracted from the PDF around that spot and from nearby pages.

Trust the images over the extracted text: the text is often missing (scanned pages) or garbled \
(equations, tables, figures). When they clicked something, answer about the marked thing.

Explain in a way that helps them understand, not only what the answer is. Refer to pages as \
(p. N) using the page numbers you are given. The chat shows plain text: do not use Markdown or \
LaTeX. Write maths with Unicode, such as x², √(a+b), ∑, ∫, σ and →."""


class Point(BaseModel):
    """A spot on a page, 0 to 1 from the top left."""

    x: float
    y: float


class PageText(BaseModel):
    page: int
    label: str | None = None
    text: str


class Context(BaseModel):
    """Where a question comes from: a page, and optionally a spot or selection on it."""

    doc_name: str
    page: int
    page_label: str | None = None
    section: str | None = None
    point: Point | None = None
    selection: str | None = None
    nearby_text: str | None = None
    page_image: str | None = Field(default=None, description="Base64 JPEG of the whole page")
    crop: str | None = Field(default=None, description="Base64 JPEG around the point, marked")
    page_texts: list[PageText] = []


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    context: Context | None = None


class AskRequest(BaseModel):
    topic: str
    messages: list[Turn]


def page_name(page: int, label: str | None) -> str:
    """'p. 12', or 'p. 12 (printed as "xii")' when the PDF's page label differs."""
    if label and label != str(page):
        return f'p. {page} (printed as "{label}")'
    return f"p. {page}"


def describe(context: Context) -> str:
    """Where the question is from, in words."""
    where = f"{page_name(context.page, context.page_label)} of {context.doc_name}"
    if context.section:
        where += f', in "{context.section}"'
    if context.selection:
        return f"They selected this text on {where}:\n{context.selection}"
    if context.point:
        x, y = round(context.point.x * 100), round(context.point.y * 100)
        return f"They clicked a spot on {where} ({x}% across, {y}% down the page)."
    return f"They are reading {where}."


def image_block(data: str) -> dict[str, Any]:
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": data},
    }


def text_block(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def context_blocks(context: Context) -> list[dict[str, Any]]:
    """The images and text for the question being asked now."""
    blocks: list[dict[str, Any]] = []
    if context.page_image:
        blocks.append(text_block(f"The whole page, {page_name(context.page, context.page_label)}:"))
        blocks.append(image_block(context.page_image))
    if context.crop:
        blocks.append(text_block("Close-up of where they pointed, marked in red:"))
        blocks.append(image_block(context.crop))
    if context.nearby_text and not context.selection:
        blocks.append(text_block(f"Text the PDF has around that spot:\n{context.nearby_text}"))
    for page in context.page_texts:
        if page.text.strip():
            name = page_name(page.page, page.label)
            blocks.append(text_block(f"Text the PDF has on {name}:\n{page.text}"))
    return blocks


def build_messages(request: AskRequest) -> list[dict[str, Any]]:
    """
    The conversation for the model. Earlier questions keep a line saying where they were
    asked; only the newest one carries images and page text, to keep requests small.
    """
    messages: list[dict[str, Any]] = []
    last = len(request.messages) - 1
    for i, turn in enumerate(request.messages):
        if turn.role == "assistant":
            if turn.text.strip():
                messages.append({"role": "assistant", "content": turn.text})
            continue
        content: list[dict[str, Any]] = []
        if turn.context:
            content.append(text_block(describe(turn.context)))
            if i == last:
                content.extend(context_blocks(turn.context))
        content.append(text_block(f"Question: {turn.text}" if turn.context else turn.text))
        # Two user turns in a row (an earlier answer failed) are merged into one.
        if messages and messages[-1]["role"] == "user":
            messages[-1]["content"].extend(content)
        else:
            messages.append({"role": "user", "content": content})
    return messages


def system_prompt(topic: str) -> str:
    return f'{SYSTEM_PROMPT}\n\nThe PDFs are in a topic called "{topic}".'


async def stream_answer(client: AsyncAnthropic, request: AskRequest) -> AsyncIterator[str]:
    """Yield the answer's text as it arrives."""
    async with client.beta.messages.stream(
        model=MODEL,
        max_tokens=64000,
        system=system_prompt(request.topic),
        messages=build_messages(request),  # type: ignore[arg-type]
        output_config={"effort": "medium"},
        # If a safety check declines the request, the API retries it on a suitable model.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    ) as stream:
        async for text in stream.text_stream:
            yield text
        final = await stream.get_final_message()
    if final.stop_reason == "refusal":
        yield "\n\n(The model declined to answer this.)"
    elif final.stop_reason == "max_tokens":
        yield "\n\n(The answer was cut off because it got too long.)"
