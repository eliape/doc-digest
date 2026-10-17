"""
Finding new flashcards that repeat cards already in the deck, or each other, in three stages:

1. Lexical: near-identical wording (rapidfuzz) is a duplicate.
2. Embeddings: a local English model (BAAI/bge-small-en-v1.5) scores what each card means, in
   both directions, so a reworded card or the reverse of one is found too.
3. Haiku: pairs in between (the grey zone) go to Claude Haiku in one call per batch.

Guardrails come before the scores: cards that differ in polarity ("Which is NOT...") or in their
numbers and symbols (n = 3 against n = 4) are never dropped by stage 1 or 2, only by Haiku.
Text is normalised first (Markdown and LaTeX markup stripped, cloze gaps unpacked), so a cloze
card and a basic card asking for the same thing compare as alike. Everything here is English-only.
"""

import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import numpy as np
from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field
from rapidfuzz import fuzz

from .deck import CardDraft, CardType
from .usage import UsageLog, call_from_response

logger = logging.getLogger(__name__)

# Stage 1: token_sort_ratio above this (out of 100) is a duplicate.
LEXICAL_DUPLICATE = 90.0
# Stage 2: cosine similarity above this is a duplicate, below the other one a new card.
EMBED_DUPLICATE = 0.88
EMBED_DISTINCT = 0.75
# Below this (fuzz.ratio, word order counting) two questions are not the same wording, however
# many words they share.
SAME_QUESTION = 75.0

EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
# bge models find passages for a short query better with this in front of it.
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
# Stage 3's model: deciding whether two cards test one thing is a small, quick judgement.
DEDUP_MODEL = "claude-haiku-5-5"
# After a failed load, the embedding model is tried again after this many seconds.
RETRY_LOAD_SECONDS = 300

# ---- Normalising ----

CLOZE = re.compile(r"\{\{c\d+::(.*?)(?:::(.*?))?\}\}", re.S)
# $$...$$ or $...$ (not \$), \[...\] or \(...\).
MATH = re.compile(r"\$\$(.+?)\$\$|(?<!\\)\$(.+?)(?<!\\)\$|\\\[(.+?)\\\]|\\\((.+?)\\\)", re.S)

UNICODE = {
    "≤": "<=", "≥": ">=", "≠": "!=", "→": "->", "⇒": "=>", "×": "*", "·": "*", "−": "-",
    "–": "-", "÷": "/", "∞": "inf", "²": "^2", "³": "^3", "¹": "^1", "⁰": "^0", "⁴": "^4",
    "√": "sqrt", "π": "pi", "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta",
    "θ": "theta", "λ": "lambda", "μ": "mu", "σ": "sigma", "ω": "omega", "∑": "sum", "∫": "int",
}  # fmt: skip

LATEX_WORDS = {
    r"\cdot": "*", r"\times": "*", r"\div": "/", r"\leq": "<=", r"\le": "<=", r"\geq": ">=",
    r"\ge": ">=", r"\neq": "!=", r"\ne": "!=", r"\to": "->", r"\rightarrow": "->",
    r"\Rightarrow": "=>", r"\implies": "=>", r"\infty": "inf", r"\pm": "+-",
}  # fmt: skip

# Commands whose argument is just text: \mathrm{d} is d.
TEXT_COMMANDS = re.compile(
    r"\\(?:mathrm|mathbf|mathit|mathsf|mathcal|text|textbf|textit|operatorname|boldsymbol|bm)"
    r"\s*\{([^{}]*)\}"
)
FRAC = re.compile(r"\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}")
SQRT = re.compile(r"\\sqrt\s*\{([^{}]*)\}")
SPACING = re.compile(r"\\(?:left|right|big|Big|bigg|Bigg)\b|\\[,;:!]|\\q?quad\b|~")

# Words that turn a question around: "Which is NOT an example of X?"
NEGATIONS = {
    "not", "never", "except", "false", "incorrect", "least", "cannot", "no", "none", "neither",
    "nor", "without", "unless", "wrong", "invalid", "impossible", "fails", "fail",
}  # fmt: skip


def paren(text: str) -> str:
    """Parentheses around a fraction's part when it is more than one term."""
    text = text.strip()
    return text if re.fullmatch(r"[\w.^]+", text) else f"({text})"


def plain_latex(tex: str) -> str:
    """LaTeX as plain, comparable text: \\frac{a}{b} is a/b, x^{2} is x^2, \\alpha is alpha."""
    text = SPACING.sub(" ", tex)
    for word, plain in sorted(LATEX_WORDS.items(), key=lambda w: -len(w[0])):
        text = re.sub(re.escape(word) + r"(?![a-zA-Z])", f" {plain} ", text)
    # Innermost first, until nothing changes, so nested fractions come out too.
    for _ in range(10):
        before = text
        text = TEXT_COMMANDS.sub(r"\1", text)
        text = FRAC.sub(lambda m: f"{paren(m[1])}/{paren(m[2])}", text)
        text = SQRT.sub(r"sqrt(\1)", text)
        if text == before:
            break
    text = re.sub(r"([\^_])\{([^{}]*)\}", r"\1\2", text)
    text = re.sub(r"\\([a-zA-Z]+)", r" \1 ", text)
    text = text.replace("{", " ").replace("}", " ").replace("\\", " ")
    text = re.sub(r"\s+", " ", text).strip().lower()
    # No spaces around operators, so "a / b" and "a/b" read the same.
    return re.sub(r"\s*([=+\-*/^_<>()!,])\s*", r"\1", text)


def plain_markdown(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+", "", text, flags=re.M)
    text = re.sub(r"(\*\*|__|\*|_|`)", "", text)
    return text


def plain(text: str) -> str:
    """A side of a card as plain lower-case text, maths included, whitespace collapsed."""
    for symbol, word in UNICODE.items():
        text = text.replace(symbol, word if len(word) <= 2 else f" {word} ")
    parts: list[str] = []
    at = 0
    for match in MATH.finditer(text):
        parts.append(plain_markdown(text[at : match.start()]).lower())
        parts.append(plain_latex(next(g for g in match.groups() if g is not None)))
        at = match.end()
    parts.append(plain_markdown(text[at:]).lower())
    text = re.sub(r"\s+", " ", " ".join(parts)).replace("\\$", "$").strip()
    # Operators written in plain text too, as in "x^2 <= y".
    return re.sub(r"\s*([=+*/^<>]+)\s*", r"\1", text)


def unpack_cloze(text: str) -> tuple[str, str]:
    """A cloze card's front with its gaps as "[...]" (and hints), and the words in the gaps."""
    gaps: list[str] = []

    def blank(match: re.Match[str]) -> str:
        gaps.append(match[1])
        return f"[...] ({match[2]})" if match[2] else "[...]"

    return CLOZE.sub(blank, text), " ".join(gaps)


def has_cloze(text: str) -> bool:
    return bool(CLOZE.search(text))


def math_tokens(text: str) -> frozenset[str]:
    """The numbers, variables and exponents a side of a card holds, to tell n = 3 from n = 4."""
    tokens = set(re.findall(r"\d+(?:\.\d+)?", text))
    # Superscripts written as characters (x²) count as the exponents they are.
    for symbol, word in UNICODE.items():
        if word.startswith("^"):
            tokens.update([word, word[1:]] if symbol in text else [])
    for match in MATH.finditer(text):
        tex = plain_latex(next(g for g in match.groups() if g is not None))
        tokens.update(re.findall(r"(?<![a-z])[a-z](?![a-z])", tex))
        tokens.update(re.findall(r"[\^_][a-z0-9.]+", tex))
        tokens.update(re.findall(r"\d+(?:\.\d+)?", tex))
    return frozenset(tokens)


def negated(text: str) -> bool:
    words = set(re.findall(r"[a-z']+", text.lower()))
    return bool(words & NEGATIONS) or any(w.endswith("n't") for w in words)


@dataclass(frozen=True)
class Normalized:
    front: str
    back: str
    front_tokens: frozenset[str]
    back_tokens: frozenset[str]
    front_negated: bool
    back_negated: bool

    @property
    def combined(self) -> str:
        return f"Q: {self.front} \n A: {self.back}"

    @property
    def flipped(self) -> str:
        return f"Q: {self.back} \n A: {self.front}"


def normalize(card: CardDraft) -> Normalized:
    if card.type == "cloze":
        front, back = unpack_cloze(card.front)
    else:
        front, back = card.front, card.back
    return Normalized(
        front=plain(front),
        back=plain(back),
        front_tokens=math_tokens(front),
        back_tokens=math_tokens(back),
        front_negated=negated(front),
        back_negated=negated(back),
    )


def guardrail(new: Normalized, old: Normalized, flipped: bool = False) -> str | None:
    """
    Why two similar-looking cards may test different things, or None: a negation on one question
    and not the other, or other numbers and symbols in them. With `flipped`, the new card is
    compared the other way round (its answer against the other's question).
    """
    negation, tokens = (
        (new.back_negated, new.back_tokens) if flipped else (new.front_negated, new.front_tokens)
    )
    if negation != old.front_negated:
        return "one asks the opposite way (a negation)"
    if tokens != old.front_tokens:
        return "their numbers or symbols differ"
    return None


def reordered(new: Normalized, old: Normalized) -> str | None:
    """
    Why the same words may make another card: token_sort_ratio ignores word order, so a card
    asked the other way round ("The newton is the unit of what?") scores like a duplicate.
    """
    if fuzz.ratio(new.front, old.front) < SAME_QUESTION:
        return "the questions are worded differently"
    return None


# ---- Embeddings ----


class Embedder(Protocol):
    name: str

    def available(self) -> bool:
        """Whether it can embed, loading the model first if need be."""
        ...

    def ready(self) -> bool:
        """Whether the model is loaded already, without loading it."""
        ...

    def embed(self, texts: list[str]) -> np.ndarray:
        """L2-normalised float32 rows, one per text."""
        ...


class SentenceEmbedder:
    """
    BAAI/bge-small-en-v1.5 through sentence-transformers, on the CPU. Loaded on first use (the
    model downloads once, about 130 MB); unavailable when the package is not installed (it is
    the backend's optional "embeddings" extra) or the model can't be loaded.
    """

    def __init__(self, name: str = EMBEDDING_MODEL, enabled: bool = True) -> None:
        self.name = name
        self.enabled = enabled
        self._model: Any = None
        self._failed_at: float | None = None
        self._lock = threading.Lock()

    def available(self) -> bool:
        return self._load() is not None

    def ready(self) -> bool:
        return self._model is not None

    def _load(self) -> Any:
        if not self.enabled:
            return None
        with self._lock:
            if self._model is not None:
                return self._model
            if self._failed_at and time.monotonic() - self._failed_at < RETRY_LOAD_SECONDS:
                return None
            try:
                from sentence_transformers import SentenceTransformer

                self._model = SentenceTransformer(self.name, device="cpu")
            except ImportError:
                logger.warning(
                    "sentence-transformers is not installed: duplicates are found by wording "
                    "only. Install it with: cd backend && uv sync --extra embeddings"
                )
                self.enabled = False
            except Exception:
                logger.exception("Could not load the embedding model %s", self.name)
                self._failed_at = time.monotonic()
            return self._model

    def embed(self, texts: list[str]) -> np.ndarray:
        model = self._load()
        if model is None:
            raise RuntimeError("The embedding model is not available.")
        if not texts:
            return np.zeros((0, model.get_embedding_dimension()), dtype=np.float32)
        vectors = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
        return np.asarray(vectors, dtype=np.float32)


# ---- Screening a batch ----

Status = Literal["new", "duplicate", "reverse"]
Stage = Literal["lexical", "embedding", "haiku"]


@dataclass
class Pooled:
    """A card new ones are compared with: one in the deck, or an earlier one of the batch."""

    key: str
    card: CardDraft
    norm: Normalized
    vector: np.ndarray | None
    existing: bool


@dataclass
class Verdict:
    status: Status = "new"
    match: Pooled | None = None
    score: float | None = None
    stage: Stage | None = None
    reason: str | None = None
    # Sent to Haiku: similar, but not clearly the same.
    grey: bool = False
    flipped: bool = False
    # Was in the grey zone, but Haiku could not be asked: kept, and shown with the similar card.
    unchecked: bool = False


@dataclass
class Screening:
    verdicts: list[Verdict]
    embeddings: bool
    vectors: list[np.ndarray | None] = field(default_factory=list)


def screen(
    candidates: list[CardDraft],
    existing: list[Pooled],
    candidate_vectors: tuple[np.ndarray, np.ndarray] | None,
) -> Screening:
    """
    Stages 1 and 2 for each candidate in turn, against the deck and the candidates before it
    that were kept. `candidate_vectors` are the candidates' forward and flipped embeddings, or
    None without an embedding model; then only stage 1 runs.
    """
    pool = [p for p in existing if candidate_vectors is None or p.vector is not None]
    verdicts: list[Verdict] = []
    vectors: list[np.ndarray | None] = []
    for n, card in enumerate(candidates):
        norm = normalize(card)
        forward = candidate_vectors[0][n] if candidate_vectors is not None else None
        verdict = judge(norm, pool, forward, candidate_vectors[1][n] if candidate_vectors else None)
        verdicts.append(verdict)
        vectors.append(forward)
        if verdict.status == "new":
            pool.append(Pooled(f"new:{n}", card, norm, forward, existing=False))
    return Screening(verdicts, embeddings=candidate_vectors is not None, vectors=vectors)


def judge(
    norm: Normalized, pool: list[Pooled], forward: np.ndarray | None, flipped: np.ndarray | None
) -> Verdict:
    if not pool:
        return Verdict()
    scores = [fuzz.token_sort_ratio(norm.combined, p.norm.combined) for p in pool]
    best = int(np.argmax(scores))
    similar: Verdict | None = None
    if scores[best] > LEXICAL_DUPLICATE:
        match = pool[best]
        why = guardrail(norm, match.norm) or reordered(norm, match.norm)
        if not why:
            return Verdict("duplicate", match, scores[best], "lexical")
        similar = Verdict(match=match, score=scores[best], stage="lexical", reason=why, grey=True)
    if forward is None or flipped is None:
        return similar or Verdict()

    matrix = np.stack([p.vector for p in pool if p.vector is not None])
    ahead, back = matrix @ forward, matrix @ flipped
    combined = np.maximum(ahead, back)
    best = int(np.argmax(combined))
    score = float(combined[best])
    is_flipped = bool(back[best] > ahead[best])
    match = pool[best]
    if score < EMBED_DISTINCT:
        return similar or Verdict()
    why = guardrail(norm, match.norm, is_flipped)
    if score > EMBED_DUPLICATE and not why:
        # The same fact the other way round, against a card that only goes one way.
        status: Status = "reverse" if is_flipped and match.card.type == "basic" else "duplicate"
        return Verdict(status, match, score, "embedding", flipped=is_flipped)
    return Verdict(
        match=match, score=score, stage="embedding", reason=why, grey=True, flipped=is_flipped
    )


# ---- Stage 3: Haiku on the grey zone ----

DEDUP_PROMPT = """\
You check new flashcards against cards that are already in a deck, so the deck does not test \
the same thing twice. Each pair below has a new card and the existing card most like it. \
Decide for each pair:

- DUPLICATE: the new card tests the exact same atomic fact as the existing one, in the same \
direction: the same question in other words, or a cloze card and a basic card that ask for the \
same thing.
- REVERSE_UPGRADE: the same fact asked the opposite way: the new card's question is the \
existing card's answer, and its answer the existing card's question.
- DISTINCT: it tests something different: another condition, step, case, variable or value, \
the converse of a statement, or the opposite polarity (asking which is NOT something). Small \
differences in wording can make a different question; when unsure, choose DISTINCT.

Give a short reason for each verdict.

{pairs}"""


class PairVerdict(BaseModel):
    pair: int = Field(description="The pair's number, as listed")
    verdict: Literal["DUPLICATE", "REVERSE_UPGRADE", "DISTINCT"]
    reason: str = Field(description="One short sentence")


class PairVerdicts(BaseModel):
    verdicts: list[PairVerdict]


TYPE_NAMES: dict[CardType, str] = {
    "basic": "Basic",
    "basic_reversed": "Basic and reversed",
    "cloze": "Cloze",
    "type_answer": "Type the answer",
}


def card_text(card: CardDraft) -> str:
    if card.type == "cloze":
        extra = f"\n  Shown after: {card.back}" if card.back.strip() else ""
        return f"({TYPE_NAMES[card.type]})\n  Text: {card.front}{extra}"
    return f"({TYPE_NAMES[card.type]})\n  Question: {card.front}\n  Answer: {card.back}"


async def adjudicate(
    client: AsyncAnthropic,
    pairs: list[tuple[CardDraft, CardDraft]],
    usage: UsageLog | None = None,
    batch: str | None = None,
) -> dict[int, PairVerdict]:
    """Haiku's verdict on each (new card, existing card) pair, by its index, in one call."""
    if not pairs:
        return {}
    listed = "\n\n".join(
        f"Pair {n}\nNew card {card_text(new)}\nExisting card {card_text(old)}"
        for n, (new, old) in enumerate(pairs)
    )
    began = time.monotonic()
    response: Any = await client.messages.parse(
        model=DEDUP_MODEL,
        max_tokens=4000,
        messages=[{"role": "user", "content": DEDUP_PROMPT.format(pairs=listed)}],
        output_format=PairVerdicts,
        output_config={"effort": "low"},
    )
    if usage:
        usage.record(
            call_from_response(
                "flashcards",
                DEDUP_MODEL,
                response,
                time.monotonic() - began,
                mode="dedup",
                question=batch,
            )
        )
    parsed = response.parsed_output
    return {v.pair: v for v in parsed.verdicts if 0 <= v.pair < len(pairs)} if parsed else {}


def apply_verdict(verdict: Verdict, said: PairVerdict | None) -> None:
    """Settle a grey-zone verdict by Haiku's word, or keep the card unchecked without one."""
    verdict.grey = False
    if said is None:
        verdict.unchecked = True
        return
    verdict.stage = "haiku"
    verdict.reason = said.reason
    match = verdict.match
    if said.verdict == "DUPLICATE":
        verdict.status = "duplicate"
    elif said.verdict == "REVERSE_UPGRADE" and match is not None:
        # A reverse of a card that goes both ways already is a duplicate; of a cloze or
        # type-the-answer card it is a question of its own.
        verdict.status = {"basic": "reverse", "basic_reversed": "duplicate"}.get(
            match.card.type, "new"
        )  # type: ignore[assignment]
    else:
        verdict.status = "new"
