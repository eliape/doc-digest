"""
The PDFs the app has been given, kept on disk by content hash, with each
page's text and printed label, and page images rendered on demand.
"""

import asyncio
import hashlib
import io
import json
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path

import pypdfium2 as pdfium

# PDFium is not thread-safe, so every call into it goes through this lock.
_pdfium = threading.Lock()

# A page with less extracted text than this is read as an image: it is
# probably scanned, a slide, or mostly a figure.
MIN_TEXT_CHARS = 200


@dataclass
class Bookmark:
    title: str
    level: int
    page: int


@dataclass
class PageInfo:
    page: int
    label: str | None
    text: str

    @property
    def scanned(self) -> bool:
        """Whether the page should be looked at rather than read as text."""
        return len(self.text.strip()) < MIN_TEXT_CHARS or garbled(self.text)


@dataclass
class DocInfo:
    id: str
    name: str
    page_count: int
    pages: list[PageInfo]
    bookmarks: list[Bookmark] = field(default_factory=list)

    def label(self, page: int) -> str | None:
        return self.pages[page - 1].label if 1 <= page <= self.page_count else None


def garbled(text: str) -> bool:
    """Text that extraction mangled: mostly replacement or control characters."""
    stripped = "".join(text.split())
    if not stripped:
        return False
    bad = sum(1 for ch in stripped if ch == "�" or (ord(ch) < 32) or 0xE000 <= ord(ch) <= 0xF8FF)
    return bad / len(stripped) > 0.2


def page_name(doc: DocInfo, page: int) -> str:
    """'p. 12', or 'p. 12 (printed "xii")' when the printed page number differs."""
    label = doc.label(page)
    if label and label != str(page):
        return f'p. {page} (printed "{label}")'
    return f"p. {page}"


def _clean(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "\n".join(lines).strip()


def _read(path: Path, doc_id: str, name: str) -> DocInfo:
    with _pdfium:
        pdf = pdfium.PdfDocument(path)
        try:
            pages = []
            for i in range(len(pdf)):
                page = pdf[i]
                textpage = page.get_textpage()
                try:
                    text = _clean(textpage.get_text_range())
                finally:
                    textpage.close()
                    page.close()
                label = pdf.get_page_label(i) or None
                pages.append(PageInfo(page=i + 1, label=label, text=text))
            bookmarks = []
            for item in pdf.get_toc():
                dest = item.get_dest()
                index = dest.get_index() if dest else None
                if index is not None and index >= 0:
                    bookmarks.append(
                        Bookmark(title=item.get_title(), level=item.level + 1, page=index + 1)
                    )
        finally:
            pdf.close()
    return DocInfo(id=doc_id, name=name, page_count=len(pages), pages=pages, bookmarks=bookmarks)


def _render(path: Path, page_number: int, longest_side: int) -> bytes:
    with _pdfium:
        pdf = pdfium.PdfDocument(path)
        try:
            page = pdf[page_number - 1]
            width, height = page.get_size()
            scale = longest_side / max(width, height)
            image = page.render(scale=scale).to_pil().convert("RGB")
            page.close()
        finally:
            pdf.close()
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=82)
    return out.getvalue()


class Library:
    """PDFs on disk under `root`, one folder per document, named by a hash of its bytes."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._docs: dict[str, DocInfo] = {}

    def folder(self, doc_id: str) -> Path:
        return self.root / "docs" / doc_id

    async def add(self, data: bytes, name: str) -> DocInfo:
        """Store a PDF (once, however often it is added) and read its pages."""
        doc_id = hashlib.sha256(data).hexdigest()[:16]
        if doc_id in self._docs:
            return self._docs[doc_id]
        folder = self.folder(doc_id)
        folder.mkdir(parents=True, exist_ok=True)
        source = folder / "source.pdf"
        if not source.exists():
            source.write_bytes(data)
        pages_file = folder / "pages.json"
        if pages_file.exists():
            doc = _load_doc(json.loads(pages_file.read_text()))
        else:
            doc = await asyncio.to_thread(_read, source, doc_id, name)
            pages_file.write_text(json.dumps(asdict(doc), ensure_ascii=False))
        doc.name = name
        self._docs[doc_id] = doc
        return doc

    def get(self, doc_id: str) -> DocInfo | None:
        if doc_id not in self._docs:
            pages_file = self.folder(doc_id) / "pages.json"
            if pages_file.exists():
                self._docs[doc_id] = _load_doc(json.loads(pages_file.read_text()))
        return self._docs.get(doc_id)

    async def render(self, doc_id: str, page: int, longest_side: int = 1568) -> bytes:
        """A page as a JPEG whose longer side is `longest_side` pixels."""
        return await asyncio.to_thread(
            _render, self.folder(doc_id) / "source.pdf", page, longest_side
        )


def _load_doc(raw: dict) -> DocInfo:
    return DocInfo(
        id=raw["id"],
        name=raw["name"],
        page_count=raw["page_count"],
        pages=[PageInfo(**p) for p in raw["pages"]],
        bookmarks=[Bookmark(**b) for b in raw.get("bookmarks", [])],
    )
