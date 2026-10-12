"""
A map of each PDF for the answering model: a short summary, an outline of
sections with page ranges, and the key terms, equations, figures and tables
with their pages. A cheap model writes it, 20 pages at a time.
"""

import asyncio
import base64
import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field

from .library import DocInfo, Library, page_name
from .usage import UsageLog, call_from_response

logger = logging.getLogger(__name__)

INDEX_MODEL = "claude-haiku-5-5"
PAGES_PER_CHUNK = 20
# Scanned pages are sent as images this size: enough to read body text.
INDEX_IMAGE_SIDE = 1400
# How many chunks of one document are indexed at the same time.
PARALLEL_CHUNKS = 3

EntryKind = Literal["term", "acronym", "definition", "equation", "figure", "table"]
ReferenceKind = Literal["section", "chapter", "figure", "table", "equation", "document", "other"]


class Section(BaseModel):
    title: str = Field(description="The heading as printed, with its number if it has one")
    level: int = Field(description="1 for a chapter or top-level part, 2 for a section, 3 below")
    start_page: int = Field(description="PDF page number where it starts")
    end_page: int = Field(description="PDF page number where it ends (within these pages)")
    summary: str = Field(description="One or two sentences on what it covers")


class Entry(BaseModel):
    kind: EntryKind
    name: str = Field(description='E.g. "Bayes\' theorem", "SVM", "Figure 3.2", "Eq. (4.7)"')
    description: str = Field(description="One line: what it is, defines or shows")
    pages: list[int] = Field(description="PDF page numbers where it appears or is defined")


class Reference(BaseModel):
    page: int = Field(description="PDF page number the reference is on")
    target: str = Field(description='What it points to, e.g. "Section 2.3", "Smith et al. (2019)"')
    kind: ReferenceKind


class ChunkIndex(BaseModel):
    summary: str = Field(description="Two or three sentences on what these pages cover")
    sections: list[Section]
    entries: list[Entry]
    references: list[Reference]


class DocSummary(BaseModel):
    title: str = Field(description="The document's title")
    summary: str = Field(
        description="Three to five sentences: what it is, what it covers, for whom"
    )


class ChunkRecord(BaseModel):
    start_page: int
    end_page: int
    summary: str


class DocIndex(BaseModel):
    """The stored index of one PDF. PDF page numbers throughout; labels map them to printed ones."""

    doc_id: str
    title: str = ""
    summary: str = ""
    page_count: int
    labels: list[str | None]
    scanned_pages: list[int] = []
    chunks: list[ChunkRecord] = []
    sections: list[Section] = []
    entries: list[Entry] = []
    references: list[Reference] = []
    complete: bool = False


CHUNK_PROMPT = """\
These are pages {start}–{end} of "{name}" ({count} pages in all). Index them so that \
someone answering questions about the document can find where things are.

- sections: every chapter, section and subsection that appears or continues on these pages, \
with the PDF page numbers it spans here. A section that started earlier and continues here \
is listed again with its title.
- entries: key terms, acronyms, definitions, numbered or important equations, figures and \
tables, each with the PDF pages it is on. Skip passing mentions.
- references: explicit pointers to other parts of this document or to other works, such as \
"see Section 4.2", "as shown in Figure 3", or a cited paper or book.

Always use the PDF page numbers given in the "=== PDF page N ===" headers, not the numbers \
printed on the pages. Be brief: one line per summary or description."""

SUMMARY_PROMPT = """\
Below is an index of "{name}" ({count} pages), written a few pages at a time. Give the \
document's title and a short summary of the whole document."""


def chunk_ranges(page_count: int, size: int = PAGES_PER_CHUNK) -> list[tuple[int, int]]:
    return [(start, min(start + size - 1, page_count)) for start in range(1, page_count + 1, size)]


async def chunk_content(library: Library, doc: DocInfo, start: int, end: int) -> list[dict]:
    """The pages for one indexing call: text where extraction works, images where it doesn't."""
    blocks: list[dict[str, Any]] = []
    hints = [b for b in doc.bookmarks if start <= b.page <= end]
    if hints:
        lines = "\n".join(f"{'  ' * (b.level - 1)}{b.title} (PDF page {b.page})" for b in hints)
        blocks.append(
            {"type": "text", "text": f"The PDF's own bookmarks for these pages:\n{lines}"}
        )
    for n in range(start, end + 1):
        page = doc.pages[n - 1]
        header = f"=== PDF page {n} ({page_name(doc, n)}) ==="
        if page.scanned:
            image = await library.render(doc.id, n, INDEX_IMAGE_SIDE)
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
        else:
            blocks.append({"type": "text", "text": f"{header}\n{page.text}"})
    return blocks


def clamp_chunk(chunk: ChunkIndex, start: int, end: int) -> ChunkIndex:
    """Keep page numbers inside the pages the model was shown."""

    def fix(n: int) -> int:
        return min(max(n, start), end)

    for s in chunk.sections:
        s.start_page, s.end_page = fix(s.start_page), fix(s.end_page)
        if s.end_page < s.start_page:
            s.end_page = s.start_page
        s.level = min(max(s.level, 1), 4)
    for e in chunk.entries:
        e.pages = sorted({fix(n) for n in e.pages}) or [start]
    for r in chunk.references:
        r.page = fix(r.page)
    return chunk


def merge_sections(sections: list[Section]) -> list[Section]:
    """Join a section that runs across chunk boundaries into one entry."""
    merged: list[Section] = []
    for s in sorted(sections, key=lambda s: (s.start_page, s.level)):
        same = next(
            (
                m
                for m in reversed(merged)
                if m.title.strip().lower() == s.title.strip().lower()
                and m.level == s.level
                and s.start_page <= m.end_page + 1
            ),
            None,
        )
        if same:
            same.end_page = max(same.end_page, s.end_page)
            if s.summary and s.summary not in same.summary:
                same.summary = f"{same.summary} {s.summary}".strip()
        else:
            merged.append(s.model_copy())
    return merged


def merge_entries(entries: list[Entry]) -> list[Entry]:
    """One entry per (kind, name), with all the pages it was found on."""
    merged: dict[tuple[str, str], Entry] = {}
    for e in entries:
        key = (e.kind, " ".join(e.name.lower().split()))
        if key in merged:
            merged[key].pages = sorted(set(merged[key].pages) | set(e.pages))
        else:
            merged[key] = e.model_copy()
    return sorted(merged.values(), key=lambda e: (min(e.pages), e.kind, e.name))


Status = Literal["queued", "indexing", "ready", "error"]


class Indexer:
    """Indexes documents in the background, one at a time, and keeps their status."""

    def __init__(
        self,
        library: Library,
        usage: UsageLog,
        client_factory: Callable[[], AsyncAnthropic | None],
    ) -> None:
        self.library = library
        self.usage = usage
        self.client_factory = client_factory
        self.status: dict[str, dict[str, Any]] = {}
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._indexes: dict[str, DocIndex] = {}

    def index_path(self, doc_id: str) -> Path:
        return self.library.folder(doc_id) / "index.json"

    def get(self, doc_id: str) -> DocIndex | None:
        """The index so far, complete or partial."""
        if doc_id not in self._indexes:
            path = self.index_path(doc_id)
            if path.exists():
                self._indexes[doc_id] = DocIndex.model_validate_json(path.read_text())
        return self._indexes.get(doc_id)

    def _save(self, index: DocIndex) -> None:
        self._indexes[index.doc_id] = index
        self.index_path(index.doc_id).write_text(index.model_dump_json())

    def doc_status(self, doc_id: str) -> dict[str, Any]:
        index = self.get(doc_id)
        if index and index.complete:
            return {
                "status": "ready",
                "pages_done": index.page_count,
                "page_count": index.page_count,
            }
        if doc_id in self.status:
            return self.status[doc_id]
        doc = self.library.get(doc_id)
        return {"status": "queued", "pages_done": 0, "page_count": doc.page_count if doc else 0}

    def resume(self, doc_id: str) -> None:
        """
        Pick a half-indexed document back up after the backend restarted (as `make dev`
        does on every backend edit), since its queue and status lived only in memory.
        """
        if doc_id not in self.status:
            self.enqueue(doc_id)

    def enqueue(self, doc_id: str) -> None:
        index = self.get(doc_id)
        if (index and index.complete) or self.status.get(doc_id, {}).get("status") in (
            "queued",
            "indexing",
        ):
            return
        doc = self.library.get(doc_id)
        self.status[doc_id] = {"status": "queued", "pages_done": 0, "page_count": doc.page_count}
        self._queue.put_nowait(doc_id)
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._work())

    async def _work(self) -> None:
        while not self._queue.empty():
            doc_id = await self._queue.get()
            try:
                await self.index(doc_id)
            except Exception as error:
                logger.exception("Indexing %s failed", doc_id)
                self.status[doc_id] = {
                    **self.status.get(doc_id, {}),
                    "status": "error",
                    "error": str(error) or type(error).__name__,
                }

    async def index(self, doc_id: str) -> DocIndex:
        """Index a document, reusing chunks already done if an earlier run stopped."""
        doc = self.library.get(doc_id)
        if doc is None:
            raise ValueError(f"Unknown document {doc_id}")
        client = self.client_factory()
        if client is None:
            raise RuntimeError("No API key: add ANTHROPIC_API_KEY to backend/.env.")
        index = self.get(doc_id) or DocIndex(
            doc_id=doc_id,
            page_count=doc.page_count,
            labels=[p.label for p in doc.pages],
            scanned_pages=[p.page for p in doc.pages if p.scanned],
        )
        done = {(c.start_page, c.end_page) for c in index.chunks}
        todo = [r for r in chunk_ranges(doc.page_count) if r not in done]
        status = {"status": "indexing", "pages_done": sum(e - s + 1 for s, e in done)}
        self.status[doc_id] = {**status, "page_count": doc.page_count}
        lock = asyncio.Lock()
        gate = asyncio.Semaphore(PARALLEL_CHUNKS)

        async def run(start: int, end: int) -> None:
            async with gate:
                chunk = await self.index_chunk(client, doc, start, end)
            async with lock:
                index.chunks.append(
                    ChunkRecord(start_page=start, end_page=end, summary=chunk.summary)
                )
                index.chunks.sort(key=lambda c: c.start_page)
                index.sections = merge_sections([*index.sections, *chunk.sections])
                index.entries = merge_entries([*index.entries, *chunk.entries])
                index.references = sorted(
                    [*index.references, *chunk.references], key=lambda r: r.page
                )
                self._save(index)
                self.status[doc_id]["pages_done"] += end - start + 1

        await asyncio.gather(*(run(s, e) for s, e in todo))
        summary = await self.summarize(client, doc, index)
        index.title, index.summary, index.complete = summary.title, summary.summary, True
        self._save(index)
        self.status[doc_id] = {
            "status": "ready",
            "pages_done": doc.page_count,
            "page_count": doc.page_count,
        }
        return index

    async def index_chunk(
        self, client: AsyncAnthropic, doc: DocInfo, start: int, end: int
    ) -> ChunkIndex:
        content = await chunk_content(self.library, doc, start, end)
        prompt = CHUNK_PROMPT.format(start=start, end=end, name=doc.name, count=doc.page_count)
        content.append({"type": "text", "text": prompt})
        began = time.monotonic()
        response = await client.messages.parse(
            model=INDEX_MODEL,
            max_tokens=16000,
            messages=[{"role": "user", "content": content}],  # type: ignore[list-item]
            output_format=ChunkIndex,
            output_config={"effort": "low"},
        )
        pages = doc.pages[start - 1 : end]
        self.usage.record(
            call_from_response(
                "index_chunk",
                INDEX_MODEL,
                response,
                time.monotonic() - began,
                doc_id=doc.id,
                text_pages=sum(not p.scanned for p in pages),
                image_pages=sum(p.scanned for p in pages),
            )
        )
        if response.parsed_output is None:
            raise RuntimeError(
                f"No index came back for pages {start}–{end} ({response.stop_reason})"
            )
        return clamp_chunk(response.parsed_output, start, end)

    async def summarize(self, client: AsyncAnthropic, doc: DocInfo, index: DocIndex) -> DocSummary:
        outline = render_outline(doc, index, with_entries=False)
        chunks = "\n".join(f"pp. {c.start_page}–{c.end_page}: {c.summary}" for c in index.chunks)
        text = (
            f"{SUMMARY_PROMPT.format(name=doc.name, count=doc.page_count)}\n\n{chunks}\n\n{outline}"
        )
        began = time.monotonic()
        response = await client.messages.parse(
            model=INDEX_MODEL,
            max_tokens=4000,
            messages=[{"role": "user", "content": text}],
            output_format=DocSummary,
            output_config={"effort": "low"},
        )
        self.usage.record(
            call_from_response(
                "index_summary", INDEX_MODEL, response, time.monotonic() - began, doc_id=doc.id
            )
        )
        if response.parsed_output is None:
            raise RuntimeError(f"No summary came back ({response.stop_reason})")
        return response.parsed_output


def page_range(doc: DocInfo, start: int, end: int) -> str:
    """'pp. 12–15', with printed numbers when they differ: 'pp. 12–15 (printed x–xiii)'."""
    if start == end:
        return page_name(doc, start)
    first, last = doc.label(start), doc.label(end)
    text = f"pp. {start}–{end}"
    if first and last and (first, last) != (str(start), str(end)):
        text += f' (printed "{first}"–"{last}")'
    return text


def render_outline(
    doc: DocInfo,
    index: DocIndex,
    with_entries: bool = True,
    max_level: int = 4,
    pages: tuple[int, int] | None = None,
) -> str:
    """The index as indented text for the model."""
    lo, hi = pages or (1, doc.page_count)
    lines = ["Sections:"]
    for s in index.sections:
        if s.level <= max_level and s.end_page >= lo and s.start_page <= hi:
            indent = "  " * (s.level - 1)
            lines.append(f"{indent}- {s.title} [{page_range(doc, s.start_page, s.end_page)}]")
            if s.summary:
                lines.append(f"{indent}  {s.summary}")
    if with_entries:
        by_kind: dict[str, list[str]] = {}
        for e in index.entries:
            if any(lo <= p <= hi for p in e.pages):
                where = ", ".join(str(p) for p in e.pages[:6])
                by_kind.setdefault(e.kind, []).append(f"- {e.name} (pp. {where}): {e.description}")
        for kind, items in by_kind.items():
            lines.append(f"\n{kind.capitalize()}s:")
            lines.extend(items)
        refs = [r for r in index.references if lo <= r.page <= hi]
        if refs:
            lines.append("\nReferences:")
            lines.extend(f"- p. {r.page} → {r.target} ({r.kind})" for r in refs)
    return "\n".join(lines)
