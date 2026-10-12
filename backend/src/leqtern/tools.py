"""
The tools the answering model uses to find its way around a topic's PDFs:
search the indexes and the PDFs' text, look at a document's outline, and
read pages.
"""

import base64
import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from .index import DocIndex, Indexer, page_range, render_outline
from .library import DocInfo, Library, page_name

MAX_PAGES_PER_READ = 8
# Pages read as images during lookups; about half the tokens of a full-size 1568 px page.
READ_IMAGE_SIDE = 1100
SEARCH_RESULTS = 8

STOPWORDS = set(
    "a an and are as at be by for from how in is it of on or that the this to was what when "
    "where which who why with does do did can i me my we our you your about into than then "
    "there these those its their".split()
)


def stem(word: str) -> str:
    """Trim common English endings so "derivatives" matches "derivative"."""
    if len(word) <= 4:
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith("es") and word[:-2].endswith(("s", "x", "z", "ch", "sh")):
        return word[:-2]
    if word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    for suffix in ("ing", "ed"):
        if word.endswith(suffix) and len(word) > len(suffix) + 3:
            return word[: -len(suffix)]
    return word


def terms(text: str) -> list[str]:
    """Lowercased words without stopwords, with plural and verb endings trimmed."""
    words = re.findall(r"[^\W_]+", text.lower())
    out = []
    for w in words:
        if w in STOPWORDS:
            continue
        out.append(stem(w))
    return out


@dataclass
class TopicDoc:
    """A document in the topic being asked about, under a short alias like D1."""

    alias: str
    info: DocInfo
    index: DocIndex | None
    status: dict[str, Any]


class SearchInput(BaseModel):
    query: str = Field(min_length=1)
    docs: list[str] | None = None


class OutlineInput(BaseModel):
    doc: str
    from_page: int | None = None
    to_page: int | None = None


class ReadInput(BaseModel):
    doc: str
    pages: list[int] = Field(min_length=1)
    images: bool = False


TOOLS: list[dict[str, Any]] = [
    {
        "name": "search",
        "description": (
            "Search the topic's documents. Looks through the index (sections, key terms, "
            "definitions, equations, figures, tables) and through the text of every page that "
            "has extractable text. Scanned pages are only found through the index. Returns "
            "matching sections and entries with their pages, and pages whose text matches, "
            "with snippets. Use several short queries with different wordings if the first "
            "finds too little."
        ),
        "eager_input_streaming": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Words to look for"},
                "docs": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Only these documents, by alias (e.g. D2). Default: all.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_outline",
        "description": (
            "A document's full index: its sections with page ranges and summaries, then its "
            "key terms, definitions, equations, figures, tables and cross-references with "
            "pages. Optionally only for a range of PDF pages."
        ),
        "eager_input_streaming": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "doc": {"type": "string", "description": "Document alias, e.g. D1"},
                "from_page": {"type": "integer"},
                "to_page": {"type": "integer"},
            },
            "required": ["doc"],
        },
    },
    {
        "name": "read_pages",
        "description": (
            f"Read up to {MAX_PAGES_PER_READ} pages of a document by PDF page number. Pages "
            "with a text layer come back as text; scanned pages come back as images. Set "
            "images to true to also see text pages as images, which you need for equations, "
            "figures, tables and diagrams, since extracted text garbles them. Answers must be "
            "based on pages you have read, not on the index."
        ),
        "eager_input_streaming": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "doc": {"type": "string", "description": "Document alias, e.g. D1"},
                "pages": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "PDF page numbers (not printed page numbers)",
                },
                "images": {"type": "boolean"},
            },
            "required": ["doc", "pages"],
        },
    },
]


class ToolError(Exception):
    """A problem the model should be told about so it can try again differently."""


class Toolbox:
    """Runs the tools for one question, over the documents of one topic."""

    def __init__(self, library: Library, docs: list[TopicDoc]) -> None:
        self.library = library
        self.docs = {d.alias: d for d in docs}
        self.pages_read: list[tuple[str, int]] = []

    def doc(self, alias: str) -> TopicDoc:
        found = self.docs.get(alias.strip().upper())
        if not found:
            known = ", ".join(f"{a} ({d.info.name})" for a, d in self.docs.items())
            raise ToolError(f"There is no document {alias!r}. The documents are: {known}.")
        return found

    async def run(self, name: str, raw: Any) -> list[dict[str, Any]] | str:
        """Run a tool. Returns tool-result content: text, or text and image blocks."""
        try:
            if name == "search":
                return self.search(SearchInput.model_validate(raw))
            if name == "get_outline":
                return self.outline(OutlineInput.model_validate(raw))
            if name == "read_pages":
                return await self.read(ReadInput.model_validate(raw))
        except ValidationError as error:
            raise ToolError(f"Invalid input for {name}: {error.errors()[0]['msg']}") from error
        raise ToolError(f"There is no tool called {name}.")

    def describe(self, name: str, raw: Any) -> str:
        """What a tool call is doing, in words for the chat."""
        try:
            if name == "search":
                return f"Searched for “{raw.get('query', '')}”"
            if name == "get_outline":
                return f"Looked at the outline of {self.doc(raw['doc']).info.name}"
            if name == "read_pages":
                doc = self.doc(raw["doc"]).info
                pages = sorted(set(raw["pages"]))
                if len(pages) == 1:
                    where = f"p. {pages[0]}"
                elif pages == list(range(pages[0], pages[-1] + 1)):
                    where = f"pp. {pages[0]}–{pages[-1]}"
                else:
                    where = "pp. " + ", ".join(map(str, pages))
                return f"Read {doc.name}, {where}"
        except (KeyError, TypeError, AttributeError, ToolError):
            pass
        return f"Used {name}"

    def search(self, args: SearchInput) -> str:
        docs = [self.doc(a) for a in args.docs] if args.docs else list(self.docs.values())
        query = terms(args.query)
        if not query:
            raise ToolError("The query has no searchable words.")
        phrase = " ".join(args.query.lower().split())

        index_hits: list[tuple[float, str]] = []
        for d in docs:
            if not d.index:
                continue
            for s in d.index.sections:
                score = match(query, phrase, s.title, s.summary)
                if score:
                    where = page_range(d.info, s.start_page, s.end_page)
                    index_hits.append(
                        (score, f"[{d.alias}] Section “{s.title}”, {where}: {s.summary}")
                    )
            for e in d.index.entries:
                score = match(query, phrase, e.name, e.description)
                if score:
                    pages = ", ".join(map(str, e.pages[:8]))
                    index_hits.append(
                        (score, f"[{d.alias}] {e.kind} “{e.name}” (pp. {pages}): {e.description}")
                    )

        text_hits = search_pages(docs, query, phrase)

        lines = [f"Search for “{args.query}”:"]
        lines.append("\nIn the index:")
        best = sorted(index_hits, key=lambda h: -h[0])[:SEARCH_RESULTS]
        lines.extend(f"- {text}" for _, text in best)
        if not best:
            lines.append("- nothing")
        unindexed = [d.alias for d in docs if not (d.index and d.index.complete)]
        if unindexed:
            lines.append(f"(Not fully indexed yet: {', '.join(unindexed)}.)")
        lines.append("\nIn the pages' text:")
        lines.extend(f"- {text}" for text in text_hits)
        if not text_hits:
            lines.append("- nothing")
        return "\n".join(lines)

    def outline(self, args: OutlineInput) -> str:
        d = self.doc(args.doc)
        if not d.index or not d.index.chunks:
            return (
                f"{d.info.name} has not been indexed yet. Use search, which also looks through "
                "the pages' text, or read_pages."
            )
        lo = max(1, args.from_page or 1)
        hi = min(d.info.page_count, args.to_page or d.info.page_count)
        head = f"{d.alias}: {d.info.name}, {d.info.page_count} pages."
        if d.index.title:
            head += f" {d.index.title}. {d.index.summary}"
        if not d.index.complete:
            done = sum(c.end_page - c.start_page + 1 for c in d.index.chunks)
            head += f" (Index in progress: {done} of {d.info.page_count} pages so far.)"
        return f"{head}\n\n{render_outline(d.info, d.index, pages=(lo, hi))}"

    async def read(self, args: ReadInput) -> list[dict[str, Any]]:
        d = self.doc(args.doc)
        pages = sorted(set(args.pages))
        if len(pages) > MAX_PAGES_PER_READ:
            raise ToolError(f"At most {MAX_PAGES_PER_READ} pages at a time.")
        outside = [p for p in pages if not 1 <= p <= d.info.page_count]
        if outside:
            raise ToolError(f"{d.info.name} has PDF pages 1–{d.info.page_count}; not {outside}.")
        blocks: list[dict[str, Any]] = []
        for n in pages:
            page = d.info.pages[n - 1]
            self.pages_read.append((d.alias, n))
            header = f"{d.info.name}, {page_name(d.info, n)}:"
            if page.scanned or args.images:
                image = await self.library.render(d.info.id, n, READ_IMAGE_SIDE)
                blocks.append({"type": "text", "text": header})
                blocks.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": base64.b64encode(image).decode(),
                        },
                    }
                )
                if page.text.strip() and not page.scanned:
                    blocks.append({"type": "text", "text": f"Its extracted text:\n{page.text}"})
            else:
                blocks.append({"type": "text", "text": f"{header}\n{page.text}"})
        return blocks


def match(query: list[str], phrase: str, name: str, description: str) -> float:
    """How well an index item matches: words in its name count most, the whole phrase more."""
    name_terms = set(terms(name))
    desc_terms = set(terms(description))
    score = sum(3.0 if t in name_terms else 1.0 if t in desc_terms else 0.0 for t in query)
    if score and phrase in f"{name} {description}".lower():
        score += 4.0
    # Most of the query should match, not one common word.
    covered = sum(t in name_terms or t in desc_terms for t in query)
    return score if covered >= max(1, math.ceil(len(set(query)) / 2)) else 0.0


def search_pages(docs: list[TopicDoc], query: list[str], phrase: str) -> list[str]:
    """Pages whose text matches, ranked like BM25, with a snippet around the first match."""
    pages = [(d, p) for d in docs for p in d.info.pages if p.text.strip()]
    if not pages:
        return []
    counted = [Counter(terms(p.text)) for _, p in pages]
    avg_len = sum(sum(c.values()) for c in counted) / len(counted) or 1
    unique = set(query)
    df = {t: sum(1 for c in counted if t in c) for t in unique}
    scored = []
    for (d, p), counts in zip(pages, counted, strict=True):
        length = sum(counts.values()) or 1
        score = 0.0
        for t in unique:
            tf = counts.get(t, 0)
            if tf:
                idf = math.log(1 + (len(pages) - df[t] + 0.5) / (df[t] + 0.5))
                score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / avg_len))
        if score and phrase in " ".join(p.text.lower().split()):
            score *= 1.5
        if score:
            scored.append((score, d, p))
    scored.sort(key=lambda s: -s[0])
    return [
        f"[{d.alias}] {page_name(d.info, p.page)}: “{snippet(p.text, query)}”"
        for _, d, p in scored[:SEARCH_RESULTS]
    ]


def snippet(text: str, query: list[str], width: int = 220) -> str:
    flat = " ".join(text.split())
    lower = flat.lower()
    at = min((i for t in query if (i := lower.find(t)) >= 0), default=0)
    start = max(0, at - width // 3)
    piece = flat[start : start + width]
    return ("…" if start else "") + piece + ("…" if start + width < len(flat) else "")


def overview(docs: list[TopicDoc], current: str | None) -> str:
    """
    A compact map of the topic for every request: each document's summary and
    status, and the top of the open document's outline. The rest is looked up
    with the tools.
    """
    lines = []
    for d in docs:
        line = f"{d.alias}: {d.info.name} ({d.info.page_count} pages"
        status = d.status.get("status")
        if status == "ready":
            line += ", indexed"
        elif status == "error":
            line += ", indexing failed: only text search and reading work"
        else:
            done = d.status.get("pages_done", 0)
            line += f", indexing: {done} of {d.info.page_count} pages done"
        scanned = len(d.index.scanned_pages) if d.index else sum(p.scanned for p in d.info.pages)
        if scanned:
            line += f", {scanned} pages scanned or without text"
        line += ")"
        if d.alias == current:
            line += " — open now"
        lines.append(line)
        if d.index and d.index.title:
            lines.append(f"  {d.index.title}. {d.index.summary}")
        if d.index and d.index.sections:
            top_level = 2 if d.alias == current else 1
            limit = 60 if d.alias == current else 25
            outline = [
                f"  {'  ' * (s.level - 1)}- {s.title} "
                f"[{page_range(d.info, s.start_page, s.end_page)}]"
                for s in d.index.sections
                if s.level <= top_level
            ]
            lines.extend(outline[:limit])
            if len(outline) > limit:
                lines.append(f"  … {len(outline) - limit} more; use get_outline")
    return "\n".join(lines)


def topic_docs(library: Library, indexer: Indexer, ids: list[str]) -> list[TopicDoc]:
    """The topic's documents that the backend has, under aliases D1, D2, … in the given order."""
    docs = []
    for doc_id in ids:
        info = library.get(doc_id)
        if info:
            alias = f"D{len(docs) + 1}"
            docs.append(TopicDoc(alias, info, indexer.get(doc_id), indexer.doc_status(doc_id)))
    return docs
