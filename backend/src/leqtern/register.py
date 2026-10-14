"""
A topic's register: short notes on what the reader has worked on, solved, struggled with and
understood there, so a new discussion can build on the earlier ones instead of starting over.

Haiku writes the notes when the reader leaves a discussion, reading only the turns it has not
seen yet. Answers get a few of them, picked without a model call: the ones about where the
reader is pointing, the ones sharing words with the question, and recent struggles.
"""

import asyncio
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field, ValidationError

from .ask import AskRequest, Turn, describe
from .quiz import LETTERS, QuizRecord, score
from .tools import terms
from .usage import UsageLog, call_from_response

logger = logging.getLogger(__name__)

# Reading a discussion and writing a few lines about it: a cheap, quick model is enough.
REGISTER_MODEL = "claude-haiku-5-5"

Kind = Literal["worked_on", "solved", "struggled", "understood"]

KIND_NAMES: dict[str, str] = {
    "worked_on": "Worked on",
    "solved": "Solved",
    "struggled": "Struggled with",
    "understood": "Understood",
}

# At most this many notes go with a question.
MAX_NOTES = 8
# Of those, at most this many are recent struggles that matched nothing else.
MAX_STRUGGLES = 3
# A note about pages this close to where the reader is pointing counts as about the same thing.
NEARBY_PAGES = 2
# Haiku sees at most this many of the topic's notes (the most recently updated) when writing.
WRITER_NOTES = 60
# An answer is cut to its start and end for Haiku: enough to see what was worked out.
ANSWER_HEAD = 1200
ANSWER_TAIL = 300
# How long a question waits for notes still being written before going without them.
WAIT_SECONDS = 20.0


class Note(BaseModel):
    """One thing the reader did or found hard, about one problem or one idea."""

    id: str
    kind: Kind
    title: str = Field(description='What it is about, e.g. "July exam Q6 a)"')
    note: str = Field(description="One sentence on what happened")
    doc_id: str | None = None
    doc_name: str | None = None
    pages: list[int] = []
    chat_id: str | None = Field(default=None, description="The discussion it was last noted from")
    created: float
    updated: float


class Register(BaseModel):
    version: Literal[1] = 1
    notes: list[Note] = []
    # Per discussion, the keys of the turns Haiku has read.
    seen: dict[str, list[str]] = {}


class RegisterTurn(Turn):
    key: str = Field(
        description="Names the turn; it changes when the turn does (a quiz being answered)"
    )


class DiscussionRequest(BaseModel):
    """A discussion the reader left, for Haiku to note what is new in it."""

    topic: str
    chat_id: str
    title: str | None = None
    docs: list[str] = Field(default=[], description="Backend ids of the topic's PDFs")
    doc_names: dict[str, str] = Field(
        default={}, description="The name each PDF has in this topic, by backend id"
    )
    messages: list[RegisterTurn]


# Topic ids come from the frontend and name files, so only plain ones are accepted.
TOPIC_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def valid_topic_id(topic_id: str) -> bool:
    return bool(TOPIC_ID.match(topic_id))


class Registers:
    """Each topic's register, as one JSON file per topic."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._locks: dict[str, asyncio.Lock] = {}

    def path(self, topic_id: str) -> Path:
        if not valid_topic_id(topic_id):
            raise ValueError(f"Not a topic id: {topic_id!r}")
        return self.root / f"{topic_id}.json"

    def lock(self, topic_id: str) -> asyncio.Lock:
        """Held while a topic's notes are being written, so questions can wait for them."""
        return self._locks.setdefault(topic_id, asyncio.Lock())

    def load(self, topic_id: str) -> Register:
        try:
            return Register.model_validate_json(self.path(topic_id).read_text())
        except FileNotFoundError:
            return Register()
        except (ValidationError, json.JSONDecodeError):
            logger.exception("Unreadable register for topic %s; starting it again", topic_id)
            return Register()

    def save(self, topic_id: str, register: Register) -> None:
        """Replace the topic's register, via a temporary file so a crash can't leave half a file."""
        path = self.path(topic_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(register.model_dump_json(indent=1))
        os.replace(temporary, path)

    def delete(self, topic_id: str) -> None:
        self.path(topic_id).unlink(missing_ok=True)
        self._locks.pop(topic_id, None)

    async def settled(self, topic_id: str) -> Register:
        """The topic's register once notes being written for it are done, or after a wait."""
        lock = self.lock(topic_id)
        if lock.locked():
            try:
                await asyncio.wait_for(lock.acquire(), WAIT_SECONDS)
                lock.release()
            except TimeoutError:
                logger.warning(
                    "Notes for topic %s took too long; answering without new ones", topic_id
                )
        return self.load(topic_id)


# ---- Picking notes for a question ----


def words(text: str) -> set[str]:
    """The words of `text` worth matching on: not stopwords, and not one or two letters."""
    return {w for w in terms(text) if len(w) >= 3 or any(c.isdigit() for c in w)}


def wants_notes(request: AskRequest) -> bool:
    """
    Notes go with a discussion's first question, and with a question about a spot the reader
    points at. A follow-up builds on the answer before it, which already had them.
    """
    if not request.messages or request.messages[-1].role != "user":
        return False
    newest = request.messages[-1]
    first = not any(t.role == "assistant" for t in request.messages[:-1])
    pointed = bool(newest.context and (newest.context.point or newest.context.selection))
    return first or pointed


def pick(register: Register, newest: Turn, chat_id: str | None) -> list[Note]:
    """
    The notes for a question: those about the pages it points at or sharing words with it,
    the closest first, then recent struggles, at most MAX_NOTES. Notes from the discussion
    being had are left out, since its history already has them.
    """
    notes = [n for n in register.notes if not chat_id or n.chat_id != chat_id]
    if len(notes) <= MAX_NOTES:
        return sorted(notes, key=lambda n: n.updated)
    context = newest.context
    asked = " ".join(
        part
        for part in (
            newest.text,
            context.selection if context else None,
            context.section if context else None,
            context.nearby_text if context else None,
        )
        if part
    )
    query = words(asked)

    def relevance(note: Note) -> float:
        points = 0.0
        if context and context.doc_id and note.doc_id == context.doc_id and note.pages:
            distance = min(abs(p - context.page) for p in note.pages)
            if distance <= NEARBY_PAGES:
                points += 4 - distance
        shared = len(query & words(f"{note.title} {note.note}"))
        return points + min(shared, 3)

    scored = [(relevance(n), n) for n in notes]
    matching = [n for s, n in sorted(scored, key=lambda x: (-x[0], -x[1].updated)) if s > 0]
    picked = matching[:MAX_NOTES]
    taken = {n.id for n in picked}
    struggles = sorted(
        (n for n in notes if n.kind == "struggled" and n.id not in taken),
        key=lambda n: -n.updated,
    )
    picked += struggles[: min(MAX_STRUGGLES, MAX_NOTES - len(picked))]
    return sorted(picked, key=lambda n: n.updated)


def pages_text(pages: list[int]) -> str:
    pages = sorted(set(pages))
    if not pages:
        return ""
    if len(pages) == 1:
        return f"p. {pages[0]}"
    if pages[-1] - pages[0] == len(pages) - 1:
        return f"pp. {pages[0]}–{pages[-1]}"
    return "pp. " + ", ".join(str(p) for p in pages)


def note_line(note: Note) -> str:
    where = ", ".join(part for part in (note.doc_name, pages_text(note.pages)) if part)
    about = f"{note.title} ({where})" if where else note.title
    return f"- {KIND_NAMES[note.kind]}: {about}: {note.note}"


def notes_block(notes: list[Note]) -> dict[str, Any] | None:
    """The notes as one text block for the newest question, or None without any."""
    if not notes:
        return None
    lines = "\n".join(note_line(n) for n in notes)
    return {
        "type": "text",
        "text": f"Notes on their earlier discussions in this topic:\n{lines}",
    }


# ---- Writing notes from a discussion ----


WRITER_PROMPT = """\
A student studies "{topic}" with a tutor, asking questions about PDFs: {docs}. You keep a \
register of what the student has done in this topic, so later discussions can build on it: \
skip pitfalls they already got past, remind them of a step they used before, and point out \
what they keep struggling with.

The register so far:
{notes}

The discussion{title}, from where you last read it:
{transcript}

Write the notes this adds to the register. Each note is about one well-defined thing: one \
problem or part of a problem, or one idea. Kinds:
- worked_on: they worked on a problem without finishing it, or it is unclear whether they did.
- solved: they got to the answer of a problem, with or without help.
- struggled: a mistake, misconception or step they got stuck on, and what got them past it.
- understood: an idea they asked about and got clear on.

Rules:
- Note what the student did and found hard, not what the material says.
- The title names the thing so it can be found again, using the documents' own numbers and \
names: "July exam Q6 a)", "Exercise 3.12", "Bernoulli's equation". At most eight words.
- The note is one sentence on what happened: the method that worked, or the trap and the way \
out. E.g. "Took moments about the hinge; first forgot the reaction force at B."
- doc is the PDF's file name as listed above, and pages the PDF page numbers it is on.
- When the discussion carries on with something already in the register (a problem worked on \
is now solved, the same struggle came back), update that note by giving its id, with the \
whole note rewritten. Leave notes that did not change out.
- Small talk, a quick definition or anything not worth remembering gets no note. Most \
discussions add one to four notes; none is fine.
- Write in the language of the discussion."""


class WrittenNote(BaseModel):
    id: str | None = Field(
        default=None,
        description="The id of the register's note this rewrites, or null for a new one",
    )
    kind: Kind
    title: str
    note: str
    doc: str | None = Field(default=None, description="The PDF's file name, as listed")
    pages: list[int] = []


class WrittenNotes(BaseModel):
    notes: list[WrittenNote]


def clip(text: str) -> str:
    """An answer's start and end: what was worked out, and where it ended up."""
    text = text.strip()
    if len(text) <= ANSWER_HEAD + ANSWER_TAIL + 20:
        return text
    return f"{text[:ANSWER_HEAD].rstrip()} […] {text[-ANSWER_TAIL:].lstrip()}"


def quiz_summary(quiz: QuizRecord) -> str:
    """A quiz as how they did: only the questions they got wrong are spelled out."""
    right, answered = score(quiz)
    lines = [f'[Quiz] "{quiz.title}": {right} of {len(quiz.questions)} right']
    if answered < len(quiz.questions):
        lines[0] += f" ({answered} answered)"
    for q, picked in zip(quiz.questions, quiz.picked, strict=False):
        if picked is not None and picked != q.answer and 0 <= picked < len(q.choices):
            lines.append(
                f"- Wrong: {q.question} They chose {LETTERS[picked]}) {q.choices[picked]}; "
                f"the answer is {LETTERS[q.answer]}) {q.choices[q.answer]}."
            )
    if quiz.recommendation:
        lines.append(f"They were advised: {quiz.recommendation}")
    return "\n".join(lines)


def user_line(turn: Turn) -> str:
    where = f"{describe(turn.context)} " if turn.context else ""
    text = turn.text.strip()
    if turn.mode == "quiz":
        return f"Student: {where}They asked for a quiz" + (f" on: {text}" if text else ".")
    if turn.mode == "socratic":
        said = text or "(guide me with questions)"
        return f"Student (being guided by questions): {where}{said}"
    return f"Student: {where}{text}"


def transcript(turns: list[Turn]) -> str:
    lines = []
    for turn in turns:
        if turn.role == "user":
            lines.append(user_line(turn))
        elif turn.quiz:
            lines.append(f"Tutor: {quiz_summary(turn.quiz)}")
        elif turn.text.strip():
            lines.append(f"Tutor: {clip(turn.text)}")
    return "\n\n".join(lines)


def unread(request: DiscussionRequest, register: Register) -> tuple[list[Turn], list[str]]:
    """
    The turns Haiku has not read, up to the latest answer, with the question before the first
    of them when that was read already (a quiz answered since), and the keys to mark as read.
    Nothing when no answer is new.
    """
    seen = set(register.seen.get(request.chat_id, []))
    last_answer = max(
        (i for i, t in enumerate(request.messages) if t.role == "assistant"), default=-1
    )
    turns = request.messages[: last_answer + 1]
    new = [i for i, t in enumerate(turns) if t.key not in seen]
    if not any(
        turns[i].role == "assistant" and (turns[i].text.strip() or turns[i].quiz) for i in new
    ):
        return [], []
    start = new[0]
    if start > 0 and turns[start].role == "assistant" and turns[start - 1].role == "user":
        start -= 1
    return turns[start:], [t.key for t in turns]


def register_text(notes: list[Note]) -> str:
    if not notes:
        return "(empty)"
    lines = []
    for n in notes:
        where = ", ".join(part for part in (n.doc_name, pages_text(n.pages)) if part)
        lines.append(
            f"[{n.id}] {n.kind}: {n.title}" + (f" ({where})" if where else "") + f": {n.note}"
        )
    return "\n".join(lines)


def apply(
    register: Register,
    written: list[WrittenNote],
    chat_id: str,
    doc_ids: dict[str, str],
    now: float,
) -> int:
    """Add Haiku's new notes and rewrite the ones it updated. Returns how many changed."""
    by_id = {n.id: n for n in register.notes}
    by_name = {name.lower(): doc_id for name, doc_id in doc_ids.items()}
    changed = 0
    for w in written:
        title, text = w.title.strip(), w.note.strip()
        if not title or not text:
            continue
        doc_name = w.doc.strip() if w.doc and w.doc.strip() else None
        doc_id = by_name.get(doc_name.lower()) if doc_name else None
        pages = sorted({p for p in w.pages if p > 0})[:12]
        fields = {
            "kind": w.kind,
            "title": title[:120],
            "note": text[:400],
            "doc_id": doc_id,
            "doc_name": doc_name,
            "pages": pages,
            "chat_id": chat_id,
            "updated": now,
        }
        existing = by_id.get(w.id) if w.id else None
        if existing:
            for name, value in fields.items():
                setattr(existing, name, value)
        else:
            note = Note(id=uuid.uuid4().hex[:8], created=now, **fields)
            register.notes.append(note)
            by_id[note.id] = note
        changed += 1
    return changed


async def write_notes(
    client: AsyncAnthropic,
    register: Register,
    request: DiscussionRequest,
    doc_names: dict[str, str],
    usage: UsageLog | None = None,
) -> int:
    """
    Have Haiku note what is new in a discussion, into `register`. Returns how many notes were
    added or rewritten; 0 without a call when no answer is new. `doc_names` maps the topic's
    PDFs' file names to their backend ids.
    """
    turns, keys = unread(request, register)
    if not turns:
        return 0
    recent = sorted(register.notes, key=lambda n: n.updated)[-WRITER_NOTES:]
    prompt = WRITER_PROMPT.format(
        topic=request.topic,
        docs=", ".join(doc_names) or "(none named)",
        notes=register_text(recent),
        title=f' "{request.title}"' if request.title else "",
        transcript=transcript(turns),
    )
    began = time.monotonic()
    response: Any = await client.messages.parse(
        model=REGISTER_MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
        output_format=WrittenNotes,
        output_config={"effort": "low"},
    )
    if usage:
        usage.record(
            call_from_response("register", REGISTER_MODEL, response, time.monotonic() - began)
        )
    parsed = response.parsed_output
    changed = apply(
        register, parsed.notes if parsed else [], request.chat_id, doc_names, time.time()
    )
    register.seen[request.chat_id] = keys
    return changed
