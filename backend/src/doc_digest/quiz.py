"""
Quizzes: multiple-choice questions the reader clicks through in the chat. The
answering model writes them; how the reader did goes back into the chat history,
so later answers and quizzes can build on it, and Haiku suggests what to review.
"""

import time
from typing import Any

from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field

from .usage import UsageLog, call_from_response

# Writes the short recommendation after a quiz: a cheap, quick model is enough.
RECOMMEND_MODEL = "claude-haiku-5-5"

LETTERS = "ABCDEFGH"


class QuizQuestion(BaseModel):
    question: str = Field(description="The question. Markdown, with maths in LaTeX")
    choices: list[str] = Field(description="3 or 4 possible answers, exactly one of them right")
    answer: int = Field(description="Index of the right choice in `choices`, from 0")
    explanation: str = Field(
        description="Why the right answer is right, in a sentence or two, citing the pages"
    )


class Quiz(BaseModel):
    title: str = Field(description="A few words naming what the quiz is about")
    questions: list[QuizQuestion]


class QuizRecord(Quiz):
    """A quiz as the chat keeps it: with the reader's answers and the recommendation."""

    picked: list[int | None] = Field(
        default=[], description="The choice the reader picked for each question, if any"
    )
    recommendation: str | None = None


def clean(quiz: Quiz) -> Quiz:
    """Drop questions the reader could not answer: too few choices, or no right one among them."""
    questions = [
        q for q in quiz.questions if len(q.choices) >= 2 and 0 <= q.answer < len(q.choices)
    ]
    return Quiz(title=quiz.title, questions=questions[: len(LETTERS)])


def quiz_text(quiz: Quiz) -> str:
    """A quiz as the model wrote it, for the chat history."""
    lines = [f"[Quiz] {quiz.title} (shown to them as questions to click through)"]
    for n, q in enumerate(quiz.questions, 1):
        lines.append(f"{n}. {q.question}")
        lines.extend(f"   {LETTERS[i]}) {choice}" for i, choice in enumerate(q.choices))
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
            lines.append(
                f"{n}. Wrong: they chose {LETTERS[picked]}) {chose}; "
                f"the answer is {LETTERS[q.answer]}) {q.choices[q.answer]}."
            )
    if quiz.recommendation:
        lines.append(f"They were advised: {quiz.recommendation}")
    return "\n".join(lines)


RECOMMEND_PROMPT = """\
Someone studying "{topic}" just took a multiple-choice quiz. {about}

The quiz, with the right answers and why:
{quiz}

{results}

Write them a short recommendation, at most two sentences, on what to review: name the idea \
behind what they got wrong and where to read about it again, e.g. "Try reading the definition \
of the derivative again (book.pdf, p. 41)." Cite pages only as the explanations above give \
them, in the form (file name, p. N). Speak to them directly, without a preamble."""


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
