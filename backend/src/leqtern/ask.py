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

from .quiz import Quiz, QuizRecord, clean, quiz_text, results_text
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
they study together form a topic; a map of the topic's documents comes with their newest question.

With a question you may get:
- when they clicked or selected something, an image of a band 80% of a page tall centred on \
that spot, which is marked in red; near the top or bottom of a page it runs into the previous or \
next page, with a grey dashed line at the page break;
- text extracted from the PDF for what the image shows, and around the spot.
When they attached nothing, you only get the page they are on. Such questions usually follow \
up on the conversation; when one refers to something on the page instead ("this", "the \
equation", "the figure"), read the page with read_pages before answering.

Trust the images over the extracted text: the text is often missing (scanned pages) or garbled \
(equations, tables, figures). When they clicked something, answer about the marked thing.

Finding things in the topic:
- If what they are looking at is enough, answer from it directly.
- Otherwise use the tools. The map and the index show where things probably are; they are a \
guide, not the evidence. Search with different words, check other documents, or read \
neighbouring pages when a lookup finds too little. Read the pages before relying on them.
- Use the images option of read_pages for equations, figures, tables and diagrams.
- Keep lookups proportionate: a few searches and reads, not the whole topic.

Citing: cite the pages you actually read or were shown, never the index or summaries. Write \
each citation as (file name, p. N) or (file name, pp. N–M), with the document's file name \
exactly as the map lists it (not its alias like D1) and PDF page numbers, e.g. (book.pdf, p. 41). \
Keep this form even when answering in another language: the chat turns it into a link to the \
page. If the topic does not contain the answer, say so, then answer from general knowledge and \
say that you are doing so.

Explain in a way that helps them understand, not only what the answer is. Keep answers short by \
default: answer the question directly and give the key idea in a few short paragraphs. Go into \
longer derivations, worked examples or background when they ask for more. The chat renders \
Markdown, so use it where it helps (short paragraphs, lists, **bold** for key terms), but keep \
answers conversational rather than report-like. Write all maths in LaTeX: $...$ inline and \
$$...$$ on its own line for display equations. Write a literal dollar sign as \\$.

Socratic sessions: they can ask you to teach them something by asking them questions instead \
of explaining it. Their turns in such a session start with [Socratic]. In a session:
- Help them work it out themselves, starting from what they pointed at or asked about: ask what \
they already make of it, or ask about its first step.
- Ask one question at a time and stop after it. Keep each turn short: a line of feedback on \
their answer, then the next question.
- When they are right, say so briefly and go a step further. When they are partly right or \
wrong, do not correct them outright: point them at what to look at (a term, a step, part of \
the equation or figure) or ask a smaller question.
- If they are still stuck after a couple of hints, or ask you to just tell them, explain that \
step briefly and carry on with a question.
- Work towards the key idea of what they pointed at or asked about. Once they have it, say so, \
sum up in a few lines what they worked out, and ask whether they want to go further.
Turns without [Socratic] are ordinary questions: answer them as usual. The first one after a \
session starts with [Socratic session ended], because they switched back to normal answers: \
stop asking them questions and answer directly.

Quizzes: they can ask for a multiple-choice quiz with a turn starting with [Quiz]. They click \
through it in the chat, and how they did comes back in a turn starting with [Quiz results]. When \
you write a quiz:
- Ask 4 to 6 questions about what they pointed at, and about what they asked it to focus on, \
unless they ask for another number. When they give nothing to focus on, you get the section \
they are reading up to where they are: ask about that, and nothing after that point.
- Give each question 3 or 4 choices with exactly one right; make the wrong ones plausible \
mistakes, not jokes.
- Test understanding (why something holds, what follows, which case applies) rather than \
recall of wording.
- Explain each right answer in a sentence or two. Don't cite pages as sources; refer to the \
text only when it helps to look at something, e.g. "Look at equation (2.3) (book.pdf, p. 41)" \
or "As in the worked example (book.pdf, p. 40)", in the citation form above.
- Write it from what you are shown; there is no looking things up for a quiz.
- After earlier quizzes, come back to what they got wrong.
In your other answers, use quiz results to adapt: build on what they know, and go over what \
they got wrong when it comes up.

Their earlier work: some questions come with notes on their earlier discussions in this topic: \
problems they worked on or solved, what they struggled with and what they understood. Build on \
them. Don't go over pitfalls they already got past unless they slip again. When a step is like \
one they took before, say so briefly, e.g. "As in Q6 a), take moments about the hinge." When \
they run into something they struggled with before, point it out. A note can say in how many \
discussions it came up: a struggle that keeps coming back is where they need help most, so \
when it comes up, slow down on that step and check they have it this time. "Got past" notes \
are struggles they have since overcome. Bring a note up only when it helps. Notes are not \
sources: don't cite them, and read the pages before relying on them."""

# What a Socratic session's first turn asks for, when the reader typed nothing.
SOCRATIC_START = "Start a Socratic session about what they pointed at: ask your first question."
# What a quiz request asks for; the reader's words, if any, say what to focus on.
QUIZ_START = "Write a quiz about what they pointed at."
# What a quiz request with nothing to focus on asks for; the section's pages come with it.
QUIZ_SECTION = (
    "Write a quiz on the section they are reading, up to where they are: nothing after the "
    "spot they pointed at or the page they are on."
)
# Marks their first ordinary question after a Socratic session.
SOCRATIC_END = (
    "[Socratic session ended] They switched back to normal answers: stop asking them "
    "questions and answer directly."
)


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
    page_image: str | None = Field(
        default=None, description="Base64 JPEG of the whole page, or of a band around the spot"
    )
    image_pages: list[int] = Field(
        default=[], description="Pages the band shows parts of; empty for the whole page"
    )
    page_texts: list[PageText] = []


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    context: Context | None = None
    mode: Literal["socratic", "quiz"] | None = Field(
        default=None,
        description="Set on the reader's turns in Socratic mode, and on their quiz requests",
    )
    quiz: QuizRecord | None = Field(
        default=None, description="On the model's side: the quiz it wrote, with how they did"
    )


# The models the reader can pick in the chat.
AnswerModel = Literal["claude-opus-5-5", "claude-sonnet-5-5"]


class AskRequest(BaseModel):
    topic: str
    topic_id: str | None = Field(default=None, description="The topic's id, for its register")
    chat_id: str | None = Field(default=None, description="The discussion's id")
    docs: list[str] = Field(default=[], description="Backend ids of the topic's PDFs, tab order")
    doc_names: dict[str, str] = Field(
        default={}, description="The name each PDF has in this topic, by backend id"
    )
    messages: list[Turn]
    model: AnswerModel | None = Field(default=None, description="Defaults to ANSWER_MODEL")
    instructions: str = Field(default="", description="The reader's instructions, from Settings")


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


# The page image is the source of truth; its text layer is only a hint, so a part is enough.
MAX_PAGE_TEXT = 3000


# What the model gets instead of the open page, when they attached nothing.
PAGE_NOT_SHOWN = (
    "(The page is not shown. If the question is about something on it, read it with "
    'read_pages, doc "{alias}", before answering, with images for equations or figures.)'
)


def context_blocks(context: Context) -> list[dict[str, Any]]:
    """The images and text for the question being asked now."""
    blocks: list[dict[str, Any]] = []
    labels = {p.page: p.label for p in context.page_texts}
    labels[context.page] = context.page_label
    if context.page_image:
        if context.image_pages:
            parts = " into ".join(page_name(n, labels.get(n)) for n in context.image_pages)
            caption = f"Around where they pointed, marked in red ({parts}):"
        else:
            caption = f"The whole page, {page_name(context.page, context.page_label)}:"
        blocks.append(text_block(caption))
        blocks.append(image_block(context.page_image))
    if context.nearby_text and not context.selection:
        blocks.append(text_block(f"Text the PDF has around that spot:\n{context.nearby_text}"))
    for page in context.page_texts:
        if page.text.strip():
            name = page_name(page.page, page.label)
            text = page.text
            if len(text) > MAX_PAGE_TEXT:
                text = text[:MAX_PAGE_TEXT].rstrip() + " …"
            where = f"the part of {name} in the image" if context.image_pages else name
            blocks.append(text_block(f"Text the PDF has on {where}:\n{text}"))
    return blocks


def question_text(turn: Turn, starts_session: bool = False, ends_session: bool = False) -> str:
    """
    What the reader said. Socratic turns and quiz requests are marked, and so is the first
    ordinary question after a session. A session or a quiz starts from what they pointed at,
    and their words, if any, say what to focus on; a quiz without them covers the section.
    """
    text = turn.text.strip()
    if turn.mode == "quiz":
        if text:
            return f"[Quiz] {QUIZ_START} Focus on: {text}"
        return f"[Quiz] {QUIZ_SECTION if turn.context else QUIZ_START}"
    if turn.mode == "socratic":
        if not text:
            return f"[Socratic] {SOCRATIC_START}"
        if starts_session and turn.context:
            return f"[Socratic] {SOCRATIC_START} Focus on: {text}"
        return f"[Socratic] {text}"
    question = f"Question: {turn.text}" if turn.context else turn.text
    return f"{SOCRATIC_END}\n{question}" if ends_session else question


def build_messages(request: AskRequest, aliases: dict[str, str] | None = None) -> list[dict]:
    """
    The conversation for the model. Earlier questions keep a line saying where they were
    asked; only the newest one carries images and page text, to keep requests small.
    """
    aliases = aliases or {}
    messages: list[dict[str, Any]] = []
    last = len(request.messages) - 1
    in_session = False
    for i, turn in enumerate(request.messages):
        if turn.role == "assistant":
            if turn.quiz:
                # The quiz as written, then how they did, on their side of the conversation.
                messages.append(
                    {"role": "assistant", "content": [text_block(quiz_text(turn.quiz))]}
                )
                results = results_text(turn.quiz)
                if results:
                    messages.append({"role": "user", "content": [text_block(results)]})
            elif turn.text.strip():
                messages.append({"role": "assistant", "content": [text_block(turn.text)]})
            continue
        content: list[dict[str, Any]] = []
        if turn.context:
            alias = aliases.get(turn.context.doc_id or "")
            content.append(text_block(describe(turn.context, alias)))
            if i == last:
                pointed = turn.context.point or turn.context.selection
                if pointed or not alias:
                    content.extend(context_blocks(turn.context))
                else:
                    # Nothing attached: most such questions follow up on the chat, so the
                    # page would only distract. The model reads it when the question needs it.
                    content.append(text_block(PAGE_NOT_SHOWN.format(alias=alias)))
        ends_session = in_session and turn.mode is None
        content.append(
            text_block(
                question_text(turn, starts_session=not in_session, ends_session=ends_session)
            )
        )
        in_session = turn.mode == "socratic"
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


def system_blocks(topic: str, instructions: str = "") -> list[dict[str, Any]]:
    """
    Fixed instructions, the reader's own (set once in Settings, so they rarely change and
    stay cached with the rest), and the topic's name, all cached.
    """
    own = instructions.strip()
    return [
        {"type": "text", "text": SYSTEM_PROMPT},
        *([{"type": "text", "text": READER_INSTRUCTIONS.format(own)}] if own else []),
        {
            "type": "text",
            "text": f'The topic is called "{topic}".',
            "cache_control": {"type": "ephemeral"},
        },
    ]


READER_INSTRUCTIONS = """\
The reader's own instructions for every answer. Follow them; where they differ from the guidance \
above on style, length or language, theirs win:
<reader_instructions>
{}
</reader_instructions>"""


def map_block(docs: list[TopicDoc], current: str | None) -> dict[str, Any] | None:
    """
    The topic's map, sent with the newest question rather than in the system prompt:
    it changes as indexing runs and when another tab is opened, and anything that
    changes before the chat history stops the history being read from the cache.
    """
    if not docs:
        return None
    return text_block(f"The topic's documents:\n{overview(docs, current)}")


Event = dict[str, Any]


async def write_quiz(
    client: AsyncAnthropic,
    request: AskRequest,
    usage: UsageLog | None = None,
    model: str = MODEL,
    reading: list[dict[str, Any]] | None = None,
    notes: dict[str, Any] | None = None,
) -> Quiz:
    """
    A multiple-choice quiz for the newest turn (a [Quiz] request), from what the reader is
    shown and the conversation so far, including how earlier quizzes went. `reading` is
    the section the quiz covers when they gave nothing to focus on, and `notes` the
    register's notes for it.
    """
    messages = build_messages(request)
    if reading:
        # Before the request itself, which stays last.
        messages[-1]["content"][-1:-1] = reading
    if notes:
        messages[-1]["content"].insert(0, notes)
    began = time.monotonic()
    response: Any = await client.messages.parse(
        model=model,
        max_tokens=16000,
        system=system_blocks(request.topic, request.instructions),  # type: ignore[arg-type]
        messages=messages,  # type: ignore[arg-type]
        output_format=Quiz,
        output_config={"effort": EFFORT},
    )
    if usage:
        usage.record(call_from_response("quiz", model, response, time.monotonic() - began))
    quiz = clean(response.parsed_output) if response.parsed_output else None
    if not quiz or not quiz.questions:
        raise RuntimeError(f"No quiz came back ({response.stop_reason})")
    return quiz


async def stream_answer(
    client: AsyncAnthropic,
    request: AskRequest,
    toolbox: Toolbox,
    usage: UsageLog | None = None,
    model: str = MODEL,
    notes: dict[str, Any] | None = None,
) -> AsyncIterator[Event]:
    """
    Yield the answer as events: {"type": "text"} pieces as they arrive, and a
    {"type": "step"} for each lookup the model makes. `notes` are the register's notes for
    the question, sent with it like the map, so they never break the history's cache.
    """
    aliases = {d.info.id: d.alias for d in toolbox.docs.values()}
    newest = request.messages[-1].context if request.messages else None
    current = aliases.get(newest.doc_id or "") if newest else None
    system = system_blocks(request.topic, request.instructions)
    messages: list[Any] = build_messages(request, aliases)
    topic_map = map_block(list(toolbox.docs.values()), current)
    if messages and messages[-1]["role"] == "user":
        for block in (notes, topic_map):
            if block:
                messages[-1]["content"].insert(0, block)
    tools = TOOLS if toolbox.docs else []
    began = time.monotonic()
    first_text: float | None = None

    for n in range(MAX_ROUNDS):
        last_round = n == MAX_ROUNDS - 1
        options: dict[str, Any] = {}
        if tools:
            options["tools"] = tools
            options["tool_choice"] = {"type": "none" if last_round else "auto"}
        if n > 0:
            # Cache the conversation so far once a lookup has started, so later rounds reread
            # it cheaply. Most questions take one round, where caching it would cost 25% extra.
            options["cache_control"] = {"type": "ephemeral"}
        call_began = time.monotonic()
        async with client.beta.messages.stream(
            model=model,
            max_tokens=64000,
            system=system,  # type: ignore[arg-type]
            messages=messages,
            output_config={"effort": EFFORT},
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
