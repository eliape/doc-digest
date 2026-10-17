"""
Making flashcards for Anki from what the reader points at in a PDF, or from a discussion up to
one of its answers. The model picked in the "Make flashcards" menu writes them, with the same
lookup tools answers use, then the duplicate filter (dedup.py) drops the ones the topic's deck
already has, and the reader edits the rest in a preview before they go into the deck.
"""

import asyncio
import logging
import math
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field
from rapidfuzz import fuzz, process

from .ask import (
    READER_INSTRUCTIONS,
    TOPIC_CONVENTIONS,
    TOPIC_SCOPE,
    AnswerModel,
    Context,
    Effort,
    Turn,
    context_blocks,
    describe,
    text_block,
)
from .deck import Card, CardDraft, CardSource, CardType, Deck, Decks, VectorCache, digest
from .dedup import (
    QUERY_PREFIX,
    Embedder,
    Pooled,
    Verdict,
    adjudicate,
    apply_verdict,
    has_cloze,
    normalize,
    screen,
)
from .quiz import quiz_text, results_text
from .register import Note, Register, pick
from .tools import TOOLS, Toolbox, ToolError, catalogue
from .usage import UsageLog, call_from_response

logger = logging.getLogger(__name__)

# The model writes this many times the cards asked for, so the duplicate filter can drop some
# and still leave as many as were asked for.
OVERWRITE = 1.5
# Cards of the deck shown to the model as the closest to the material, not to be repeated.
CLOSEST = 12
# Rounds of lookups before the model must write the cards with what it has.
MAX_ROUNDS = 6
# A discussion longer than this (in characters) is sent from its end: its latest part matters most.
MAX_TRANSCRIPT = 60_000
# Struggles from the register sent with the material.
MAX_STRUGGLES = 5

# Lookups here are not streamed, and eager input streaming is only for streamed tool calls.
LOOKUP_TOOLS = [{k: v for k, v in t.items() if k != "eager_input_streaming"} for t in TOOLS]

PROMPT = """\
You write flashcards that someone studying PDFs (textbooks, papers, lecture slides, exams) \
will study in Anki. The PDFs they study together form a topic; its indexed documents are listed \
at the end of these instructions.

You get the material to make the cards from: either a spot they pointed at in a PDF (an image \
of a band of the page with the spot marked in red, and its text), or a discussion they had with \
a tutor about the topic. Make the cards about that material, and about what they asked to focus \
on, if anything.

Looking things up: when the material relies on something it doesn't state (a definition, the \
conditions of a theorem, notation from earlier), look it up with the tools before writing \
about it, and read the pages before relying on them. Keep lookups few; most material needs none.

Writing cards:
- One atomic fact, idea or derivation step per card. Split a list or a result with several \
parts into several cards rather than one card asking for all of it.
- The question must stand on its own weeks later, without the PDF: name the concept, theorem \
or setting it is about ("In a Carnot cycle, ..."), never "this", "the above" or "the figure".
- Ask what matters for understanding and using the material: what terms mean, when a result \
applies and its conditions, why a step works, what each part of a formula stands for, common \
pitfalls. Skip trivia such as who wrote what, or page and equation numbers.
- Keep answers short: a word, a phrase, a formula, or a sentence or two. Put any explanation \
the answer needs in extra, in at most two sentences, or leave extra empty.
- No "always", "never", "all of the above" or "none of the above", and no trick questions.
- Write maths in LaTeX: $...$ inline and $$...$$ for a display equation. Write a literal dollar \
sign as \\$. Use Markdown only for **bold** and *italics*.
- Follow the topic's conventions (notation, signs, units) where they are given.
- Give each card's source as the document's file name as listed and the PDF page numbers it is \
on, in doc and pages; leave them empty for a card that comes from no page.

Card types; use only the ones allowed:
- basic: a question (front) and its answer (back).
- basic_reversed: a basic card that is also asked the other way round, answer to question. Only \
when both directions are unambiguous and worth knowing: a term and its definition, a symbol and \
what it stands for, two dual statements. Never for a long answer.
- cloze: a sentence or formula in front with its key part hidden: {{c1::hidden part}}, or \
{{c1::hidden part::hint}} with a hint. Hide one key term, value or part of a formula per card \
(c1 only), and keep enough around it to know what is asked. back is extra text shown with the \
answer, or empty.
- type_answer: the answer (back) is typed and compared letter by letter, so it is one exact, \
short answer: a term, a name, a number or a short expression, in plain text without LaTeX.

Cards already in the deck: you get the ones closest to this material. Don't write a card that \
tests the same thing as one of them, in either direction, in other words or as another type.

From a discussion: make cards about what it worked out, above all what they asked about, got \
wrong or found hard, not about small talk. When notes on their earlier struggles come with the \
material, make cards on the steps or ideas that tripped them up where the material covers them.

Order the cards by how much they matter, most important first. Write as many as you are asked \
for, unless the material doesn't hold that many good cards: then write fewer."""

TYPE_HINTS: dict[CardType, str] = {
    "basic": "basic",
    "basic_reversed": "basic_reversed",
    "cloze": "cloze",
    "type_answer": "type_answer",
}


class FlashcardRequest(BaseModel):
    topic: str
    topic_id: str
    docs: list[str] = Field(default=[], description="Backend ids of the topic's PDFs, tab order")
    doc_names: dict[str, str] = Field(default={}, description="Each PDF's name in this topic")
    scope: str = ""
    conventions: str = ""
    instructions: str = Field(default="", description="The reader's instructions, from Settings")
    model: AnswerModel | None = None
    effort: Effort = "medium"
    count: int = Field(default=5, ge=1, le=20)
    types: list[CardType] = Field(default=["basic", "cloze"], min_length=1)
    reverse: Literal["upgrade", "discard"] = Field(
        default="upgrade",
        description="For a new card that is the reverse of a one-way basic card in the deck: "
        "turn that card into Basic and reversed, or only drop the new one",
    )
    focus: str = Field(default="", description="What the reader asked the cards to focus on")
    context: Context | None = Field(default=None, description="The spot picked in a PDF")
    messages: list[Turn] = Field(default=[], description="A discussion, up to the answer picked")
    chat_id: str | None = None


class WrittenCard(BaseModel):
    type: CardType
    front: str = Field(description="The question, or for cloze the text with {{c1::...}}")
    back: str = Field(description="The answer, or for cloze extra text shown after it (or empty)")
    extra: str = Field(description="A short explanation shown with the answer, or empty")
    doc: str = Field(description="The source document's file name as listed, or empty")
    pages: list[int] = Field(description="The PDF pages the card comes from, or empty")


class WrittenCards(BaseModel):
    cards: list[WrittenCard]


# ---- What the model is given ----


def transcript(turns: list[Turn]) -> str:
    """A discussion as text, quizzes with how they went, from its end when it is very long."""
    lines: list[str] = []
    for turn in turns:
        if turn.role == "user":
            where = f"[{describe(turn.context)}]\n" if turn.context else ""
            mode = "(asked for a quiz) " if turn.mode == "quiz" else ""
            lines.append(f"Student: {where}{mode}{turn.text.strip()}".rstrip())
        elif turn.quiz:
            lines.append(f"Tutor: {quiz_text(turn.quiz)}")
            results = results_text(turn.quiz)
            if results:
                lines.append(f"Student: {results}")
        elif turn.text.strip():
            lines.append(f"Tutor: {turn.text.strip()}")
    text = "\n\n".join(lines)
    if len(text) > MAX_TRANSCRIPT:
        text = "(Earlier part of the discussion left out.)\n\n…" + text[-MAX_TRANSCRIPT:]
    return text


def source_text(request: FlashcardRequest) -> str:
    """The material in plain text, to find the deck's cards closest to it."""
    parts = [request.focus]
    if request.context:
        c = request.context
        parts += [c.selection or "", c.nearby_text or ""]
        if not (c.selection or c.nearby_text):
            parts += [p.text for p in c.page_texts]
    for turn in request.messages[-4:]:
        parts.append(turn.text)
    return "\n".join(p.strip() for p in parts if p and p.strip())[:4000]


def card_line(card: Card | CardDraft) -> str:
    if card.type == "cloze":
        return f"- ({card.type}) {card.front}"
    return f"- ({card.type}) Q: {card.front} | A: {card.back}"


def struggle_notes(register: Register, request: FlashcardRequest) -> list[Note]:
    """The register's struggles around the material, the ones that keep coming back first."""
    newest = Turn(role="user", text=request.focus, context=request.context)
    if request.messages:
        newest = next((t for t in reversed(request.messages) if t.role == "user"), newest)
    notes = [n for n in pick(register, newest, None) if n.kind == "struggled" and not n.resolved]
    return sorted(notes, key=lambda n: -n.weight)[:MAX_STRUGGLES]


def material(
    request: FlashcardRequest,
    aliases: dict[str, str],
    closest: list[Card],
    struggles: list[Note],
) -> list[dict[str, Any]]:
    """The user turn: the material, the deck's closest cards, struggles, and what to write."""
    blocks: list[dict[str, Any]] = []
    if request.context:
        alias = aliases.get(request.context.doc_id or "")
        blocks.append(text_block(describe(request.context, alias)))
        blocks.extend(context_blocks(request.context))
    if request.messages:
        blocks.append(text_block(f"The discussion:\n\n{transcript(request.messages)}"))
    if struggles:
        lines = "\n".join(f"- {n.title} ({n.doc_name or ''}): {n.note}" for n in struggles)
        blocks.append(text_block(f"Notes on what they struggled with in this topic:\n{lines}"))
    if closest:
        lines = "\n".join(card_line(c) for c in closest)
        blocks.append(text_block(f"Cards already in the deck closest to this material:\n{lines}"))
    else:
        blocks.append(text_block("The deck has no cards close to this material yet."))
    asked = math.ceil(request.count * OVERWRITE)
    types = ", ".join(TYPE_HINTS[t] for t in request.types)
    task = f"Write {asked} flashcards. Allowed card types: {types}."
    if request.focus.strip():
        task += f"\nFocus on: {request.focus.strip()}"
    blocks.append(text_block(task))
    return blocks


def system(request: FlashcardRequest, documents: str) -> list[dict[str, Any]]:
    about = [f'The topic is called "{request.topic}".']
    if request.scope.strip():
        about.append(TOPIC_SCOPE.format(request.scope.strip()))
    if request.conventions.strip():
        about.append(TOPIC_CONVENTIONS.format(request.conventions.strip()))
    if documents:
        about.append(documents)
    own = request.instructions.strip()
    return [
        text_block(PROMPT),
        *([text_block(READER_INSTRUCTIONS.format(own))] if own else []),
        {**text_block("\n\n".join(about)), "cache_control": {"type": "ephemeral"}},
    ]


# ---- Writing them ----


def replayable(content: list[Any]) -> list[Any]:
    """
    A response's blocks to send back after a lookup, unchanged (thinking blocks must be), but
    without the parsed output the SDK adds to text blocks, which is not part of the API's shape.
    """
    return [
        b.model_dump(exclude={"parsed_output"}, exclude_none=True)
        if hasattr(b, "model_dump")
        else b
        for b in content
    ]


async def write_cards(
    client: AsyncAnthropic,
    request: FlashcardRequest,
    toolbox: Toolbox,
    blocks: list[dict[str, Any]],
    model: str,
    usage: UsageLog | None = None,
    on_step: Callable[[str], None] = lambda _: None,
    batch: str | None = None,
) -> list[WrittenCard]:
    """The model's cards, after any lookups it makes."""
    messages: list[Any] = [{"role": "user", "content": blocks}]
    documents = catalogue(list(toolbox.docs.values()))
    tools = LOOKUP_TOOLS if toolbox.docs else []
    for n in range(MAX_ROUNDS):
        options: dict[str, Any] = {}
        if tools:
            options["tools"] = tools
            options["tool_choice"] = {"type": "none" if n == MAX_ROUNDS - 1 else "auto"}
        began = time.monotonic()
        response: Any = await client.beta.messages.parse(
            model=model,
            max_tokens=16000,
            system=system(request, documents),  # type: ignore[arg-type]
            messages=messages,
            output_format=WrittenCards,
            output_config={"effort": request.effort},
            # If a safety check declines the request, the API retries it on a suitable model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            **options,
        )
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if usage:
            usage.record(
                call_from_response(
                    "flashcards",
                    model,
                    response,
                    time.monotonic() - began,
                    effort=request.effort,
                    mode="write",
                    attached="chat" if request.messages else "spot",
                    chat_id=request.chat_id,
                    question=batch,
                    round_no=n,
                    tools=[b.name for b in tool_uses],
                )
            )
        if response.stop_reason == "refusal":
            raise RuntimeError("The model declined to write cards for this.")
        if response.stop_reason == "max_tokens":
            raise RuntimeError("The cards got too long to finish. Try asking for fewer.")
        if not tool_uses:
            parsed = response.parsed_output
            if parsed is None:
                raise RuntimeError("No cards came back. Try again.")
            return parsed.cards
        results = []
        for block in tool_uses:
            on_step(toolbox.describe(block.name, block.input))
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
        messages.append({"role": "assistant", "content": replayable(response.content)})
        messages.append({"role": "user", "content": results})
    raise RuntimeError("No cards came back. Try again.")


def drafts(
    written: list[WrittenCard], request: FlashcardRequest, toolbox: Toolbox
) -> list[CardDraft]:
    """
    The written cards as drafts, each in a type the reader allowed (or left out when none
    fits) and with its source document found by name.
    """
    allowed = set(request.types)
    by_name = {d.info.name.lower(): d.info for d in toolbox.docs.values()}
    by_alias = {a.lower(): d.info for a, d in toolbox.docs.items()}
    context = request.context
    docs = list(toolbox.docs.values())
    out: list[CardDraft] = []
    for card in written:
        kind: CardType | None = card.type
        front, back = card.front.strip(), card.back.strip()
        if not front or (kind != "cloze" and not back):
            continue
        if kind == "cloze" and not has_cloze(front):
            kind = None
        if kind not in allowed:
            fallback: dict[str, list[CardType]] = {
                "basic_reversed": ["basic", "type_answer"],
                "basic": ["basic_reversed", "type_answer"],
                "type_answer": ["basic", "basic_reversed"],
            }
            kind = next((k for k in fallback.get(kind or "", []) if k in allowed), None)
            if kind is None or not back:
                continue
        name = card.doc.strip().lower()
        info = by_name.get(name) or by_name.get(f"{name}.pdf") or by_alias.get(name)
        if info is None and not name and context and card.pages:
            # Pages without a document: the one the spot is in.
            info = next((d.info for d in docs if d.info.id == context.doc_id), None)
        source = CardSource(
            doc_id=info.id if info else None,
            doc_name=info.name if info else None,
            pages=sorted({p for p in card.pages if info and 1 <= p <= info.page_count}),
            chat_id=request.chat_id,
        )
        out.append(
            CardDraft(type=kind, front=front, back=back, extra=card.extra.strip(), source=source)
        )
    return out


# ---- The deck's vectors ----


def sync_vectors(decks: Decks, topic_id: str, deck: Deck, embedder: Embedder) -> dict[str, Any]:
    """Each card's embedding, by card id: from the cache, and made for cards new or edited since."""
    cache = decks.load_vectors(topic_id)
    rows = cache.rows()
    texts = {c.id: normalize(c).combined for c in deck.cards}
    digests = {i: digest(t, embedder.name) for i, t in texts.items()}
    missing = [i for i in texts if rows.get(i, ("", None))[0] != digests[i]]
    fresh = embedder.embed([texts[i] for i in missing]) if missing else None
    vectors = {i: rows[i][1] for i in texts if i not in missing}
    if fresh is not None:
        vectors.update(zip(missing, fresh, strict=True))
    if missing or len(rows) != len(texts):
        ids = list(texts)
        matrix = np.stack([vectors[i] for i in ids]) if ids else np.zeros((0, 0), np.float32)
        decks.save_vectors(topic_id, VectorCache(ids, [digests[i] for i in ids], matrix))
    return vectors


def closest_cards(
    deck: Deck, vectors: dict[str, Any] | None, query: str, embedder: Embedder | None
) -> list[Card]:
    """The deck's cards closest to the material: by meaning with embeddings, else by wording."""
    if not deck.cards or not query.strip():
        return deck.cards[-CLOSEST:]
    if vectors and embedder:
        embedded = [c for c in deck.cards if c.id in vectors]
        if embedded:
            matrix = np.stack([vectors[c.id] for c in embedded])
            scores = matrix @ embedder.embed([QUERY_PREFIX + query])[0]
            return [embedded[i] for i in sorted(np.argsort(-scores)[:CLOSEST].tolist())]
    texts = [normalize(c).combined for c in deck.cards]
    found = process.extract(query.lower(), texts, scorer=fuzz.token_set_ratio, limit=CLOSEST)
    return [deck.cards[i] for _, _, i in sorted(found, key=lambda f: f[2])]


# ---- All of it ----


@dataclass
class Services:
    decks: Decks
    embedder: Embedder
    usage: UsageLog | None = None


def pooled_deck(deck: Deck, vectors: dict[str, Any] | None) -> list[Pooled]:
    return [
        Pooled(c.id, c, normalize(c), vectors.get(c.id) if vectors else None, existing=True)
        for c in deck.cards
    ]


def shown(card: CardDraft, key: str) -> dict[str, Any]:
    return {"key": key, **card.model_dump()}


def match_of(verdict: Verdict) -> dict[str, Any] | None:
    match = verdict.match
    if match is None:
        return None
    return {
        "id": match.key if match.existing else None,
        "key": None if match.existing else match.key,
        "existing": match.existing,
        **match.card.model_dump(include={"type", "front", "back"}),
    }


async def make_flashcards(
    client: AsyncAnthropic,
    request: FlashcardRequest,
    toolbox: Toolbox,
    register: Register,
    services: Services,
    model: str,
) -> AsyncIterator[dict[str, Any]]:
    """
    Events while cards are made: {"type": "step"} for each lookup and stage, then one
    {"type": "result"} with the cards to preview and the ones the duplicate filter left out.
    """
    decks, embedder, usage = services.decks, services.embedder, services.usage
    # Names the batch's calls in the usage log, to count what a batch costs.
    batch = uuid.uuid4().hex[:12]
    topic_id = request.topic_id
    deck = decks.load(topic_id)
    with_embeddings = await asyncio.to_thread(embedder.available)
    vectors: dict[str, Any] | None = None
    if with_embeddings:
        try:
            vectors = await asyncio.to_thread(sync_vectors, decks, topic_id, deck, embedder)
        except Exception:
            logger.exception("Embedding the deck failed; finding duplicates by wording only")
            with_embeddings = False
    query = source_text(request)
    closest = await asyncio.to_thread(
        closest_cards, deck, vectors, query, embedder if with_embeddings else None
    )
    aliases = {d.info.id: d.alias for d in toolbox.docs.values()}
    blocks = material(request, aliases, closest, struggle_notes(register, request))

    steps: asyncio.Queue[str] = asyncio.Queue()
    writing = asyncio.create_task(
        write_cards(client, request, toolbox, blocks, model, usage, steps.put_nowait, batch)
    )
    try:
        while not writing.done() or not steps.empty():
            getter = asyncio.ensure_future(steps.get())
            done, _ = await asyncio.wait({getter, writing}, return_when=asyncio.FIRST_COMPLETED)
            if getter in done:
                yield {"type": "step", "text": getter.result()}
            else:
                getter.cancel()
        written = writing.result()
    finally:
        writing.cancel()

    candidates = drafts(written, request, toolbox)
    yield {"type": "step", "text": "Checking for duplicates"}
    pairs: tuple[np.ndarray, np.ndarray] | None = None
    if with_embeddings and candidates:
        try:
            norms = [normalize(c) for c in candidates]
            texts = [n.combined for n in norms] + [n.flipped for n in norms]
            matrix = await asyncio.to_thread(embedder.embed, texts)
            pairs = (matrix[: len(norms)], matrix[len(norms) :])
        except Exception:
            logger.exception("Embedding the new cards failed; finding duplicates by wording only")
            with_embeddings = False
    screening = screen(candidates, pooled_deck(deck, vectors if with_embeddings else None), pairs)
    grey = [(n, v) for n, v in enumerate(screening.verdicts) if v.grey and v.match]
    said = {}
    if grey:
        try:
            said = await adjudicate(
                client, [(candidates[n], v.match.card) for n, v in grey if v.match], usage, batch
            )
        except Exception:
            logger.exception("Checking similar cards with Haiku failed; keeping them, marked")
    for i, (_, verdict) in enumerate(grey):
        apply_verdict(verdict, said.get(i))

    cards: list[dict[str, Any]] = []
    filtered: list[dict[str, Any]] = []
    for n, (card, verdict) in enumerate(zip(candidates, screening.verdicts, strict=True)):
        key = f"new:{n}"
        if verdict.status == "new":
            if len(cards) < request.count:
                entry = shown(card, key)
                if verdict.unchecked:
                    entry["similar"] = match_of(verdict)
                cards.append(entry)
            continue
        match = verdict.match
        upgrade = False
        if verdict.status == "reverse" and request.reverse == "upgrade" and match:
            if match.existing:
                upgrade = True
            else:
                # The reverse of an earlier card of this batch: that one goes both ways instead.
                for entry in cards:
                    if entry["key"] == match.key and entry["type"] == "basic":
                        entry["type"] = "basic_reversed"
        filtered.append(
            {
                **shown(card, key),
                "status": verdict.status,
                "stage": verdict.stage,
                "reason": verdict.reason,
                "score": None if verdict.score is None else round(float(verdict.score), 3),
                "match": match_of(verdict),
                "upgrade": upgrade,
            }
        )
    yield {
        "type": "result",
        "cards": cards,
        "filtered": filtered,
        "embeddings": with_embeddings,
    }
