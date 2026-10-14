"""
A topic's register: short notes on what the reader has worked on, solved, struggled with and
understood there, so a new discussion can build on the earlier ones instead of starting over.

Haiku writes the notes when the reader leaves a discussion, reading only the turns it has not
seen yet, and tidies the register now and then. Answers get a few of them, picked without a
model call: the ones about where the reader is pointing, the ones sharing words with the
question, and struggles, the ones that keep coming back first. How often a note came up (its
weight) is counted here, not by the model.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field, ValidationError, model_validator

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

# How the reader showed they solved or understood something. Being told is not one of them.
Evidence = Literal["said_so", "explained_back", "answered_right", "solved_it"]

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
# A struggle that came up in this many discussions keeps coming back: it is never tidied away,
# and it goes with follow-up questions that touch on it.
RECURRING = 2
# At most this many recurring struggles go with a follow-up question.
MAX_FOLLOW_UP = 2
# The register is tidied once this many notes were added or changed since the last tidy.
TIDY_AFTER = 15
# The tidy reads at most this many notes, the most recently updated.
TIDY_NOTES = 200


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
    chats: list[str] = Field(default=[], description="Every discussion it came up in")
    evidence: Evidence | None = Field(
        default=None, description="How they showed it, for solved and understood"
    )
    resolved: bool = Field(default=False, description="A struggle they have since got past")
    created: float
    updated: float

    @model_validator(mode="after")
    def _from_one_discussion(self) -> "Note":
        # Notes saved before weights were counted came up in their one discussion.
        if not self.chats and self.chat_id:
            self.chats = [self.chat_id]
        return self

    @property
    def weight(self) -> int:
        """How many discussions it came up in."""
        return max(1, len(self.chats))

    @property
    def recurring(self) -> bool:
        """A struggle that keeps coming back and that they have not got past yet."""
        return self.kind == "struggled" and not self.resolved and self.weight >= RECURRING


class Register(BaseModel):
    version: Literal[1] = 1
    notes: list[Note] = []
    # Per discussion, the keys of the turns Haiku has read.
    seen: dict[str, list[str]] = {}
    # Notes added or changed since the last tidy; None in registers from before tidying.
    untidied: int | None = None
    tidied: float | None = None

    def pending(self) -> int:
        """Notes added or changed since the last tidy (all of them before the first one)."""
        return len(self.notes) if self.untidied is None else self.untidied


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

    def backup(self, topic_id: str) -> None:
        """Keep a copy of the register as it is before a tidy, so a bad tidy can be undone."""
        path = self.path(topic_id)
        if path.exists():
            shutil.copyfile(path, self.backup_path(topic_id))

    def backup_path(self, topic_id: str) -> Path:
        return self.path(topic_id).with_name(f"{topic_id}.before-tidy.json")

    def delete(self, topic_id: str) -> None:
        self.path(topic_id).unlink(missing_ok=True)
        self.backup_path(topic_id).unlink(missing_ok=True)
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


def asked_words(turn: Turn, around: bool = True) -> set[str]:
    """The words of a question, with what it points at (and around it, if `around`)."""
    context = turn.context
    parts = [turn.text, context.selection if context else None]
    if around and context:
        parts += [context.section, context.nearby_text]
    return words(" ".join(p for p in parts if p))


def note_words(note: Note) -> set[str]:
    return words(f"{note.title} {note.note}")


def others(register: Register, chat_id: str | None) -> list[Note]:
    """Notes from other discussions: the one being had already has its own in its history."""
    return [n for n in register.notes if not chat_id or n.chat_id != chat_id]


def pick(register: Register, newest: Turn, chat_id: str | None) -> list[Note]:
    """
    The notes for a question: those about the pages it points at or sharing words with it,
    the closest first and heavier ones before lighter, then struggles not got past yet, the
    ones that keep coming back first; at most MAX_NOTES.
    """
    notes = others(register, chat_id)
    if len(notes) <= MAX_NOTES:
        return sorted(notes, key=lambda n: n.updated)
    context = newest.context
    query = asked_words(newest)

    def relevance(note: Note) -> float:
        points = 0.0
        if context and context.doc_id and note.doc_id == context.doc_id and note.pages:
            distance = min(abs(p - context.page) for p in note.pages)
            if distance <= NEARBY_PAGES:
                points += 4 - distance
        points += min(len(query & note_words(note)), 3)
        # Among notes that fit, the ones that came up in more discussions first.
        return points + 0.5 * (min(note.weight, 4) - 1) if points else 0.0

    scored = [(relevance(n), n) for n in notes]
    matching = [n for s, n in sorted(scored, key=lambda x: (-x[0], -x[1].updated)) if s > 0]
    picked = matching[:MAX_NOTES]
    taken = {n.id for n in picked}
    struggles = sorted(
        (n for n in notes if n.kind == "struggled" and not n.resolved and n.id not in taken),
        key=lambda n: (-n.weight, -n.updated),
    )
    picked += struggles[: min(MAX_STRUGGLES, MAX_NOTES - len(picked))]
    return sorted(picked, key=lambda n: n.updated)


def follow_up(register: Register, request: AskRequest) -> list[Note]:
    """
    For a follow-up question, which gets no notes otherwise: struggles that keep coming back
    and that it shares at least two words with, unless an earlier question in the discussion
    did too (they went with that one).
    """
    *earlier, newest = [t for t in request.messages if t.role == "user"]
    query = asked_words(newest, around=False)
    before = [asked_words(t, around=False) for t in earlier]
    found = []
    for note in others(register, request.chat_id):
        if not note.recurring:
            continue
        about = note_words(note)
        if len(query & about) >= 2 and not any(len(b & about) >= 2 for b in before):
            found.append(note)
    found.sort(key=lambda n: (-n.weight, -n.updated))
    return found[:MAX_FOLLOW_UP]


def notes_for(register: Register, request: AskRequest) -> list[Note]:
    """The notes that go with the newest question (see wants_notes and follow_up)."""
    if not request.messages or request.messages[-1].role != "user":
        return []
    if wants_notes(request):
        return pick(register, request.messages[-1], request.chat_id)
    return follow_up(register, request)


def pages_text(pages: list[int]) -> str:
    pages = sorted(set(pages))
    if not pages:
        return ""
    if len(pages) == 1:
        return f"p. {pages[0]}"
    if pages[-1] - pages[0] == len(pages) - 1:
        return f"pp. {pages[0]}–{pages[-1]}"
    return "pp. " + ", ".join(str(p) for p in pages)


def note_label(note: Note) -> str:
    """E.g. "Struggled with (3 discussions)", or "Got past (struggled in 2 discussions)"."""
    times = f"{note.weight} discussions"
    if note.kind == "struggled" and note.resolved:
        return f"Got past (struggled in {times})" if note.weight > 1 else "Got past"
    label = KIND_NAMES[note.kind]
    return f"{label} ({times})" if note.weight > 1 else label


def note_line(note: Note) -> str:
    where = ", ".join(part for part in (note.doc_name, pages_text(note.pages)) if part)
    about = f"{note.title} ({where})" if where else note.title
    return f"- {note_label(note)}: {about}: {note.note}"


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

Write the notes this adds to the register. Be sparing: of each thing, ask whether a tutor \
helping this student next week would do anything differently for knowing it. Note only what \
passes: a problem they worked on, a step that tripped them up, an idea they showed they now \
have. A question asked and answered is not a note by itself. Most discussions add no notes, \
or one or two.

Each note is about one well-defined thing: one problem or part of a problem, or one idea. Kinds:
- worked_on: they worked on a problem without getting to the answer themselves, or it is \
unclear whether they did.
- solved: they got to the answer of a problem themselves, perhaps with hints; not when the \
tutor worked it out for them.
- struggled: a mistake, misconception or step they got stuck on, and what got them past it.
- understood: an idea they showed they understand. Having it explained is not understanding.

solved and understood need evidence from the discussion, given as evidence:
- said_so: they said in their own words that they get it now.
- explained_back: they explained or applied it correctly in their own words.
- answered_right: they answered quiz or Socratic questions on it right.
- solved_it: they solved a problem that uses it.
Without evidence, write worked_on instead of solved, and no note instead of understood.

Rules:
- Note what the student did and found hard, not what the material says.
- The title names the thing so it can be found again, using the documents' own numbers and \
names: "July exam Q6 a)", "Exercise 3.12", "Bernoulli's equation". At most eight words.
- The note is one sentence on what happened: the method that worked, or the trap and the way \
out. E.g. "Took moments about the hinge; first forgot the reaction force at B."
- doc is the PDF's file name as listed above, and pages the PDF page numbers it is on.
- When the discussion carries on with something already in the register (a problem worked on \
is now solved, the same struggle came back), update that note by giving its id, with the \
whole note rewritten, instead of adding another. Leave notes that did not change out.
- A struggle stays a struggle. When they show they have got past it (with evidence as above), \
update it with resolved set; when it comes back, update it with resolved unset.
- Write in the language of the discussion."""


class WrittenNote(BaseModel):
    id: str | None = Field(
        default=None,
        description="The id of the register's note this rewrites, or null for a new one",
    )
    kind: Kind
    title: str
    note: str
    evidence: Evidence | None = Field(
        default=None, description="For solved and understood: how they showed it"
    )
    resolved: bool = Field(default=False, description="For a struggle: they have got past it")
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
    """The notes for Haiku: id, kind, weight, evidence or resolved, then the note."""
    if not notes:
        return "(empty)"
    lines = []
    for n in notes:
        where = ", ".join(part for part in (n.doc_name, pages_text(n.pages)) if part)
        marks = [f"{n.weight} discussions"] if n.weight > 1 else []
        if n.evidence:
            marks.append(f"evidence: {n.evidence}")
        if n.kind == "struggled" and n.resolved:
            marks.append("resolved")
        head = f"[{n.id}] {n.kind}" + (f" ({', '.join(marks)})" if marks else "")
        lines.append(f"{head}: {n.title}" + (f" ({where})" if where else "") + f": {n.note}")
    return "\n".join(lines)


def checked(kind: Kind, evidence: Evidence | None) -> Kind | None:
    """
    The kind a note may have: solved without evidence is only worked on, and understood
    without evidence is no note (None).
    """
    if kind == "understood" and not evidence:
        return None
    if kind == "solved" and not evidence:
        return "worked_on"
    return kind


def doc_of(name: str | None, doc_ids: dict[str, str]) -> tuple[str | None, str | None]:
    """A PDF's file name as Haiku gave it, and its backend id when the topic has it."""
    name = name.strip() if name and name.strip() else None
    by_name = {n.lower(): doc_id for n, doc_id in doc_ids.items()}
    return name, by_name.get(name.lower()) if name else None


def apply(
    register: Register,
    written: list[WrittenNote],
    chat_id: str,
    doc_ids: dict[str, str],
    now: float,
) -> int:
    """
    Add Haiku's new notes and rewrite the ones it updated, counting the discussion towards
    each one's weight. Returns how many changed.
    """
    by_id = {n.id: n for n in register.notes}
    pending = register.pending()
    changed = 0
    for w in written:
        title, text = w.title.strip(), w.note.strip()
        existing = by_id.get(w.id) if w.id else None
        kind = checked(w.kind, w.evidence)
        if not title or not text or kind is None:
            continue
        resolved = w.resolved
        if existing and existing.kind == "struggled" and kind != "struggled":
            # A struggle stays one; getting past it (with evidence) resolves it.
            resolved = kind in ("solved", "understood")
            kind = "struggled"
        doc_name, doc_id = doc_of(w.doc, doc_ids)
        fields: dict[str, Any] = {
            "kind": kind,
            "title": title[:120],
            "note": text[:400],
            "evidence": w.evidence if kind in ("solved", "understood") else None,
            "resolved": resolved and kind == "struggled",
            "doc_id": doc_id,
            "doc_name": doc_name,
            "pages": sorted({p for p in w.pages if p > 0})[:12],
            "chat_id": chat_id,
            "updated": now,
        }
        if existing:
            for name, value in fields.items():
                setattr(existing, name, value)
            if chat_id not in existing.chats:
                existing.chats.append(chat_id)
        else:
            note = Note(id=uuid.uuid4().hex[:8], created=now, chats=[chat_id], **fields)
            register.notes.append(note)
            by_id[note.id] = note
        changed += 1
    register.untidied = pending + changed
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
    # Struggles that keep coming back, however old, so a new sighting updates them.
    recent += [n for n in register.notes if n.recurring and n not in recent]
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


# ---- Tidying the register ----


TIDY_PROMPT = """\
You keep a register of what a student studying "{topic}" has done, so later discussions with \
their tutor can build on it. It was written one discussion at a time, so it repeats itself and \
collects notes that no longer help. Tidy it.

The register (id, kind, how many discussions it came up in, evidence for solved and \
understood, whether a struggle is resolved, then the note), PDFs: {docs}
{notes}

Say what to change; notes you leave out stay as they are.
- merges: notes about the same thing become one, rewritten from them, listing all their ids: \
the same problem noted twice, the same struggle noted twice, a worked_on that another note \
says was solved. Also roll several solved notes from one finished exercise set or exam into \
one, when the details no longer help.
- drops: notes that would not change how a tutor helps this student, and solved or understood \
notes without evidence.

Rules:
- Never add anything the notes don't say. Keep their language.
- A struggle stays a struggle when merged, resolved only if all of it was resolved. Never \
drop a struggle that came up in two or more discussions and is not resolved.
- solved and understood keep their evidence: said_so, explained_back, answered_right or \
solved_it.
- Titles name the thing with the documents' own numbers and names, at most eight words; \
the note is one sentence.
- When the register is already tidy, change nothing."""


class Merge(BaseModel):
    ids: list[str] = Field(description="The notes this one replaces")
    kind: Kind
    title: str
    note: str
    evidence: Evidence | None = None
    resolved: bool = False
    doc: str | None = Field(default=None, description="The PDF's file name, as listed")
    pages: list[int] = []


class Drop(BaseModel):
    id: str
    reason: str


class TidyPlan(BaseModel):
    merges: list[Merge] = []
    drops: list[Drop] = []


def apply_tidy(
    register: Register, plan: TidyPlan, doc_ids: dict[str, str], now: float
) -> tuple[int, int]:
    """
    Carry out a tidy: merge notes (their discussions add up to the merged note's weight) and
    drop notes. Ids Haiku made up are ignored, each note is used once, and a struggle that
    keeps coming back is never dropped or merged into something else. Returns how many notes
    were merged away and how many dropped.
    """
    by_id = {n.id: n for n in register.notes}
    used: set[str] = set()
    replaced: dict[str, Note] = {}
    gone: set[str] = set()
    merged_away = dropped = 0
    for m in plan.merges:
        ids = [i for i in dict.fromkeys(m.ids) if i in by_id and i not in used]
        kind = checked(m.kind, m.evidence)
        title, text = m.title.strip(), m.note.strip()
        if not ids or kind is None or not title or not text:
            continue
        sources = [by_id[i] for i in ids]
        if any(n.kind == "struggled" for n in sources) and kind != "struggled":
            continue
        latest = max(sources, key=lambda n: n.updated)
        doc_name, doc_id = doc_of(m.doc, doc_ids)
        if doc_name and not doc_id:
            doc_id = next((n.doc_id for n in sources if n.doc_name == doc_name), None)
        merged = Note(
            id=sources[0].id,
            kind=kind,
            title=title[:120],
            note=text[:400],
            evidence=m.evidence if kind in ("solved", "understood") else None,
            resolved=kind == "struggled" and m.resolved and all(n.resolved for n in sources),
            doc_id=doc_id,
            doc_name=doc_name,
            pages=sorted({p for p in m.pages if p > 0})[:12],
            chat_id=latest.chat_id,
            chats=list(dict.fromkeys(c for n in sources for c in n.chats)),
            created=min(n.created for n in sources),
            updated=max(n.updated for n in sources),
        )
        used.update(ids)
        replaced[ids[0]] = merged
        gone.update(ids[1:])
        merged_away += len(ids) - 1
    for d in plan.drops:
        note = by_id.get(d.id)
        if note and d.id not in used and not note.recurring:
            used.add(d.id)
            gone.add(d.id)
            dropped += 1
    register.notes = [replaced.get(n.id, n) for n in register.notes if n.id not in gone]
    register.untidied = 0
    register.tidied = now
    return merged_away, dropped


async def tidy(
    client: AsyncAnthropic,
    register: Register,
    topic: str,
    doc_names: dict[str, str],
    usage: UsageLog | None = None,
) -> tuple[int, int]:
    """Have Haiku tidy the register. Returns how many notes were merged away and dropped."""
    notes = sorted(register.notes, key=lambda n: n.updated)[-TIDY_NOTES:]
    if len(notes) < 2:
        register.untidied = 0
        return 0, 0
    prompt = TIDY_PROMPT.format(
        topic=topic, docs=", ".join(doc_names) or "(none named)", notes=register_text(notes)
    )
    began = time.monotonic()
    response: Any = await client.messages.parse(
        model=REGISTER_MODEL,
        max_tokens=8000,
        messages=[{"role": "user", "content": prompt}],
        output_format=TidyPlan,
        output_config={"effort": "low"},
    )
    if usage:
        usage.record(
            call_from_response("register_tidy", REGISTER_MODEL, response, time.monotonic() - began)
        )
    return apply_tidy(register, response.parsed_output or TidyPlan(), doc_names, time.time())
