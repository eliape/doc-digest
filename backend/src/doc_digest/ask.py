"""
Answer a question about a topic's PDFs. The model gets the page the reader is
on (and the spot they pointed at), a compact map of the topic's documents,
and tools to search the indexes and read pages, and decides what to look up.
"""

import time
from collections.abc import AsyncIterator
from typing import Any, Literal

from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field

from .tools import TOOLS, Toolbox, ToolError, TopicDoc, overview
from .usage import UsageLog, call_from_response

# The default answering model; ANSWER_MODEL in backend/.env overrides it.
MODEL = "claude-opus-5-5"
# Low effort keeps thinking and lookups short, which is most of what an answer costs.
EFFORT = "low"
# Rounds of tool use before the model must answer with what it has.
MAX_ROUNDS = 8

SYSTEM_PROMPT = """\
You help someone learn from PDFs they are studying, such as textbooks, papers and lecture \
slides. They read in a viewer next to this chat and ask about what they are reading. The PDFs \
they study together form a topic; a map of the topic's documents follows these instructions.

With a question you may get:
- the whole page they are on, as an image, with the spot they clicked or selected marked in red;
- text extracted from the PDF around that spot and from the whole page.

Trust the images over the extracted text: the text is often missing (scanned pages) or garbled \
(equations, tables, figures). When they clicked something, answer about the marked thing.

Finding things in the topic:
- If the page they are on is enough, answer from it directly.
- Otherwise use the tools. The map and the index show where things probably are; they are a \
guide, not the evidence. Search with different words, check other documents, or read \
neighbouring pages when a lookup finds too little. Read the pages before relying on them.
- Use the images option of read_pages for equations, figures, tables and diagrams.
- Keep lookups proportionate: a few searches and reads, not the whole topic.

Citing: cite the pages you actually read or were shown, never the index or summaries, as \
(document name, p. N) using PDF page numbers, e.g. (book.pdf, p. 41). If the topic does not \
contain the answer, say so, then answer from general knowledge and say that you are doing so.

Explain in a way that helps them understand, not only what the answer is. Keep answers short by \
default: answer the question directly and give the key idea in a few short paragraphs. Go into \
longer derivations, worked examples or background when they ask for more. The chat renders \
Markdown, so use it where it helps (short paragraphs, lists, **bold** for key terms), but keep \
answers conversational rather than report-like. Write all maths in LaTeX: $...$ inline and \
$$...$$ on its own line for display equations. Write a literal dollar sign as \\$."""


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

    doc_id: str | None = Field(default=None, description="The backend's id of the document")
    doc_name: str
    page: int
    page_label: str | None = None
    section: str | None = None
    point: Point | None = None
    selection: str | None = None
    nearby_text: str | None = None
    page_image: str | None = Field(default=None, description="Base64 JPEG of the whole page")
    # Older clients also sent a close-up; it is no longer passed to the model.
    crop: str | None = Field(default=None, description="Unused")
    page_texts: list[PageText] = []


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    context: Context | None = None


class AskRequest(BaseModel):
    topic: str
    docs: list[str] = Field(default=[], description="Backend ids of the topic's PDFs, tab order")
    messages: list[Turn]


def page_name(page: int, label: str | None) -> str:
    """'p. 12', or 'p. 12 (printed as "xii")' when the PDF's page label differs."""
    if label and label != str(page):
        return f'p. {page} (printed as "{label}")'
    return f"p. {page}"


def describe(context: Context, alias: str | None = None) -> str:
    """Where the question is from, in words."""
    doc = f"{context.doc_name} ({alias})" if alias else context.doc_name
    where = f"{page_name(context.page, context.page_label)} of {doc}"
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
        name = page_name(context.page, context.page_label)
        marked = ", with where they pointed marked in red" if context.point else ""
        blocks.append(text_block(f"The whole page, {name}{marked}:"))
        blocks.append(image_block(context.page_image))
    if context.nearby_text and not context.selection:
        blocks.append(text_block(f"Text the PDF has around that spot:\n{context.nearby_text}"))
    for page in context.page_texts:
        if page.text.strip():
            name = page_name(page.page, page.label)
            blocks.append(text_block(f"Text the PDF has on {name}:\n{page.text}"))
    return blocks


def build_messages(request: AskRequest, aliases: dict[str, str] | None = None) -> list[dict]:
    """
    The conversation for the model. Earlier questions keep a line saying where they were
    asked; only the newest one carries images and page text, to keep requests small.
    """
    aliases = aliases or {}
    messages: list[dict[str, Any]] = []
    last = len(request.messages) - 1
    for i, turn in enumerate(request.messages):
        if turn.role == "assistant":
            if turn.text.strip():
                messages.append({"role": "assistant", "content": [text_block(turn.text)]})
            continue
        content: list[dict[str, Any]] = []
        if turn.context:
            alias = aliases.get(turn.context.doc_id or "")
            content.append(text_block(describe(turn.context, alias)))
            if i == last:
                content.extend(context_blocks(turn.context))
        content.append(text_block(f"Question: {turn.text}" if turn.context else turn.text))
        # Two user turns in a row (an earlier answer failed) are merged into one.
        if messages and messages[-1]["role"] == "user":
            messages[-1]["content"].extend(content)
        else:
            messages.append({"role": "user", "content": content})
    # Cache the history before the newest question. Its images are dropped on the next
    # question, so the request-wide cache entry never matches again, but this one does.
    if len(messages) > 1 and messages[-2]["role"] == "assistant":
        messages[-2]["content"][-1]["cache_control"] = {"type": "ephemeral"}
    return messages


def system_blocks(topic: str, docs: list[TopicDoc], current: str | None) -> list[dict[str, Any]]:
    """Fixed instructions first (cached), then the topic's map, which changes as indexing runs."""
    blocks: list[dict[str, Any]] = [
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
    ]
    if docs:
        topic_map = overview(docs, current)
        blocks.append(
            {"type": "text", "text": f'The topic "{topic}" has these documents:\n{topic_map}'}
        )
    else:
        blocks.append({"type": "text", "text": f'The topic is called "{topic}".'})
    return blocks


Event = dict[str, Any]


async def stream_answer(
    client: AsyncAnthropic,
    request: AskRequest,
    toolbox: Toolbox,
    usage: UsageLog | None = None,
    model: str = MODEL,
) -> AsyncIterator[Event]:
    """
    Yield the answer as events: {"type": "text"} pieces as they arrive, and a
    {"type": "step"} for each lookup the model makes.
    """
    aliases = {d.info.id: d.alias for d in toolbox.docs.values()}
    newest = request.messages[-1].context if request.messages else None
    current = aliases.get(newest.doc_id or "") if newest else None
    system = system_blocks(request.topic, list(toolbox.docs.values()), current)
    messages: list[Any] = build_messages(request, aliases)
    tools = TOOLS if toolbox.docs else []
    began = time.monotonic()
    first_text: float | None = None

    for n in range(MAX_ROUNDS):
        last_round = n == MAX_ROUNDS - 1
        options: dict[str, Any] = {}
        if tools:
            options["tools"] = tools
            options["tool_choice"] = {"type": "none" if last_round else "auto"}
        call_began = time.monotonic()
        async with client.beta.messages.stream(
            model=model,
            max_tokens=64000,
            system=system,  # type: ignore[arg-type]
            messages=messages,
            output_config={"effort": EFFORT},
            # Cache the conversation so far, so each round of lookups reuses it.
            cache_control={"type": "ephemeral"},
            # If a safety check declines the request, the API retries it on a suitable model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            **options,
        ) as stream:
            async for event in stream:
                if event.type == "text":
                    if first_text is None:
                        first_text = time.monotonic() - began
                    yield {"type": "text", "text": event.text}
            final = await stream.get_final_message()
        if usage:
            usage.record(call_from_response("answer", model, final, time.monotonic() - call_began))

        tool_uses = [b for b in final.content if b.type == "tool_use"]
        if final.stop_reason == "refusal":
            yield {"type": "text", "text": "\n\n(The model declined to answer this.)"}
            break
        if final.stop_reason == "max_tokens":
            yield {"type": "text", "text": "\n\n(The answer was cut off because it got too long.)"}
            break
        if not tool_uses:
            break

        results = []
        for block in tool_uses:
            yield {"type": "step", "text": toolbox.describe(block.name, block.input)}
            try:
                content = await toolbox.run(block.name, block.input)
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": content})
            except ToolError as error:
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(error),
                        "is_error": True,
                    }
                )
        messages.append({"role": "assistant", "content": final.content})
        messages.append({"role": "user", "content": results})

    yield {
        "type": "done",
        "seconds": round(time.monotonic() - began, 2),
        "first_text_seconds": round(first_text, 2) if first_text is not None else None,
        "pages_read": [f"{alias} p. {page}" for alias, page in toolbox.pages_read],
    }
