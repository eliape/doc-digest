"""
Quizzes: multiple-choice questions the reader clicks through in the chat. The
answering model writes them; how the reader did goes back into the chat history,
so later answers and quizzes can build on it, and Haiku suggests what to review.
"""

import random
import time
from typing import Any, Literal

from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field

from .index import page_range
from .tools import ReadInput, Toolbox, TopicDoc
from .usage import UsageLog, call_from_response

# Writes the short recommendation after a quiz: a cheap, quick model is enough.
RECOMMEND_MODEL = "claude-haiku-5-5"

LETTERS = "ABCDEFGH"


class Distractor(BaseModel):
    misconception_rationale: str = Field(
        description="Written first: the specific mistake or misconception that leads to this "
        "answer, in one sentence the reader is shown after answering, e.g. 'Uses the diameter "
        "where the formula needs the radius.' or 'Confuses negative reinforcement with "
        "punishment.'"
    )
    text: str = Field(
        description="The wrong answer that mistake produces, parallel in form, length and "
        "vocabulary to the right answer. Markdown, with maths in LaTeX"
    )


class WrittenQuestion(BaseModel):
    """A question as the model writes it: the right answer, then the mistakes that tempt."""

    level: Literal["application", "analysis"] = Field(
        description="application: a short scenario or problem where they must recognise and "
        "apply the right idea; analysis: a flawed application or argument where they must find "
        "exactly what goes wrong"
    )
    question: str = Field(
        description="The stem: a complete, self-contained question that can be answered before "
        "reading the options. Markdown, with maths in LaTeX"
    )
    answer: str = Field(description="The right answer, written like the wrong ones")
    distractors: list[Distractor] = Field(description="Exactly 3 wrong answers")
    explanation: str = Field(
        description="Why the right answer is right, in a sentence or two. Cite a page only to "
        "point at something to look at, not as a source"
    )


class WrittenQuiz(BaseModel):
    title: str = Field(description="A few words naming what the quiz is about")
    questions: list[WrittenQuestion]


class QuizQuestion(BaseModel):
    """A question as the reader sees it, with the right answer somewhere among the choices."""

    question: str
    choices: list[str]
    answer: int = Field(description="Index of the right choice in `choices`, from 0")
    explanation: str
    misconceptions: list[str | None] = Field(
        default=[], description="For each choice, the mistake behind it; None for the right one"
    )


class Quiz(BaseModel):
    title: str
    questions: list[QuizQuestion]


class QuizRecord(Quiz):
    """A quiz as the chat keeps it: with the reader's answers and the recommendation."""

    picked: list[int | None] = Field(
        default=[], description="The choice the reader picked for each question, if any"
    )
    recommendation: str | None = None


def arrange(written: WrittenQuiz, rng: random.Random | None = None) -> Quiz:
    """
    The quiz as the reader sees it: each right answer put at a random place among its wrong
    ones, so where it is gives nothing away. Questions without a right answer and at least one
    wrong one are dropped.
    """
    rng = rng or random.Random()
    questions = []
    for q in written.questions:
        wrong = [d for d in q.distractors if d.text.strip()][: len(LETTERS) - 1]
        if not q.answer.strip() or not wrong:
            continue
        # (text, the mistake behind it, whether it is the right one)
        options: list[tuple[str, str | None, bool]] = [(q.answer, None, True)]
        options += [(d.text, d.misconception_rationale.strip() or None, False) for d in wrong]
        rng.shuffle(options)
        questions.append(
            QuizQuestion(
                question=q.question,
                choices=[text for text, _, _ in options],
                answer=next(i for i, (_, _, right) in enumerate(options) if right),
                explanation=q.explanation,
                misconceptions=[why for _, why, _ in options],
            )
        )
    return Quiz(title=written.title, questions=questions)


def misconception(q: QuizQuestion, choice: int) -> str | None:
    """The mistake behind a wrong choice, if the quiz says."""
    return q.misconceptions[choice] if 0 <= choice < len(q.misconceptions) else None


def quiz_text(quiz: Quiz) -> str:
    """A quiz as the model wrote it, for the chat history."""
    lines = [f"[Quiz] {quiz.title} (shown to them as questions to click through)"]
    for n, q in enumerate(quiz.questions, 1):
        lines.append(f"{n}. {q.question}")
        for i, choice in enumerate(q.choices):
            why = misconception(q, i) if i != q.answer else None
            lines.append(f"   {LETTERS[i]}) {choice}" + (f" (the mistake: {why})" if why else ""))
        lines.append(f"   Right answer: {LETTERS[q.answer]}. {q.explanation}")
    return "\n".join(lines)


def score(quiz: QuizRecord) -> tuple[int, int]:
    """How many questions the reader got right, and how many they answered."""
    answered = [(q, p) for q, p in zip(quiz.questions, quiz.picked, strict=False) if p is not None]
    return sum(q.answer == p for q, p in answered), len(answered)


def results_text(quiz: QuizRecord) -> str | None:
    """How the reader did, question by question, or None before they answered any."""
    right, answered = score(quiz)
    if not answered:
        return None
    total = len(quiz.questions)
    if answered < total:
        lines = [f"[Quiz results] They answered {answered} of {total} questions, {right} right."]
    else:
        lines = [f"[Quiz results] They got {right} of {total} right."]
    for n, (q, picked) in enumerate(zip(quiz.questions, quiz.picked, strict=False), 1):
        if picked is None:
            lines.append(f"{n}. Not answered.")
        elif picked == q.answer:
            lines.append(f"{n}. Right.")
        else:
            chose = q.choices[picked] if 0 <= picked < len(q.choices) else "?"
            why = misconception(q, picked)
            lines.append(
                f"{n}. Wrong: they chose {LETTERS[picked]}) {chose}"
                + (f" (the mistake: {why})" if why else "")
                + f"; the answer is {LETTERS[q.answer]}) {q.choices[q.answer]}."
            )
    if quiz.recommendation:
        lines.append(f"They were advised: {quiz.recommendation}")
    return "\n".join(lines)


# A quiz with nothing to focus on covers the section being read, from its start up to the page
# they are on: at most this many pages, the last ones before that point.
SECTION_PAGES = 8
# Without any known sections, the pages up to where they are, this many.
NEARBY_PAGES = 3


def latest_section(doc: TopicDoc, page: int) -> tuple[str | None, int]:
    """
    The latest chapter or section to start at or before `page`, by the index or else the
    PDF's bookmarks, and its first page. (None, page) when no section is known.
    """
    heads = [(s.start_page, s.level, s.title) for s in doc.index.sections] if doc.index else []
    heads = heads or [(b.page, b.level, b.title) for b in doc.info.bookmarks]
    started = [h for h in heads if h[0] <= page and h[1] <= 2]
    if not started:
        return None, page
    # The latest start; of a chapter and its first section on one page, the section.
    start, _, title = max(started, key=lambda h: (h[0], h[1]))
    return title, start


async def reading_so_far(toolbox: Toolbox, doc_id: str, page: int) -> list[dict[str, Any]]:
    """The pages a quiz with nothing to focus on covers: the section up to where they are."""
    doc = next((d for d in toolbox.docs.values() if d.info.id == doc_id), None)
    if not doc or not 1 <= page <= doc.info.page_count:
        return []
    title, start = latest_section(doc, page)
    if title is None:
        first = max(1, page - NEARBY_PAGES + 1)
        intro = "No sections are known for this document. The pages up to where they are"
    else:
        first = max(start, page - SECTION_PAGES + 1)
        part = "from its start" if first == start else "its last pages"
        intro = f'The section they are reading, "{title}", {part} up to where they are'
    pages = list(range(first, page + 1))
    blocks = await toolbox.read(ReadInput(doc=doc.alias, pages=pages))
    where = page_range(doc.info, first, page)
    return [{"type": "text", "text": f"{intro} ({doc.info.name}, {where}):"}, *blocks]


RECOMMEND_PROMPT = """\
Someone studying "{topic}" just took a multiple-choice quiz. {about}

The quiz, with the right answers and why:
{quiz}

{results}

Write them a short recommendation, at most two sentences, on what to review: name the idea \
behind what they got wrong and where to read about it again, e.g. "Try reading the definition \
of the derivative again (book.pdf, p. 41)." Cite pages only as the explanations above give \
them, in the form (file name, p. N). Write any maths in LaTeX between dollar signs, as the quiz \
does, e.g. $f'(x) = 2x$, never as bare LaTeX commands or plain-text formulas: the app renders \
it. Speak to them directly, without a preamble."""


class Recommendation(BaseModel):
    text: str


async def recommend(
    client: AsyncAnthropic,
    topic: str,
    about: str,
    quiz: QuizRecord,
    usage: UsageLog | None = None,
) -> str | None:
    """What to review after a quiz, or None when they got everything right."""
    right, _ = score(quiz)
    results = results_text(quiz)
    if results is None or right == len(quiz.questions):
        return None
    prompt = RECOMMEND_PROMPT.format(
        topic=topic, about=about, quiz=quiz_text(quiz), results=results
    )
    began = time.monotonic()
    response: Any = await client.messages.parse(
        model=RECOMMEND_MODEL,
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}],
        output_format=Recommendation,
        output_config={"effort": "low"},
    )
    if usage:
        usage.record(
            call_from_response(
                "quiz_recommendation", RECOMMEND_MODEL, response, time.monotonic() - began
            )
        )
    parsed = response.parsed_output
    return parsed.text.strip() if parsed and parsed.text.strip() else None
