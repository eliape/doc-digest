import asyncio

import pytest
from fakes import FakeIndexClient
from pdfs import filler, make_pdf

from leqtern.index import (
    AUTO_RETRIES,
    RETRY_AFTER_SECONDS,
    ChunkIndex,
    ChunkRecord,
    DocIndex,
    DocSummary,
    Entry,
    Indexer,
    Section,
    chunk_ranges,
    clamp_chunk,
    merge_entries,
    merge_sections,
    render_outline,
)
from leqtern.library import Library
from leqtern.usage import UsageLog


def test_splits_documents_into_twenty_page_chunks() -> None:
    assert chunk_ranges(45) == [(1, 20), (21, 40), (41, 45)]
    assert chunk_ranges(3) == [(1, 3)]


def test_joins_sections_that_cross_chunk_boundaries() -> None:
    sections = [
        Section(title="2 Derivatives", level=1, start_page=15, end_page=20, summary="Rates."),
        Section(title="2 Derivatives", level=1, start_page=21, end_page=30, summary="Rules."),
        Section(title="2.1 The chain rule", level=2, start_page=22, end_page=24, summary="Comp."),
    ]
    merged = merge_sections(sections)
    assert [(s.title, s.start_page, s.end_page) for s in merged] == [
        ("2 Derivatives", 15, 30),
        ("2.1 The chain rule", 22, 24),
    ]
    assert merged[0].summary == "Rates. Rules."


def test_merges_entries_by_kind_and_name() -> None:
    entries = [
        Entry(kind="term", name="Derivative", description="d", pages=[12]),
        Entry(kind="term", name="derivative", description="d", pages=[30, 12]),
        Entry(kind="figure", name="Figure 2", description="f", pages=[13]),
    ]
    merged = merge_entries(entries)
    assert [(e.kind, e.pages) for e in merged] == [("term", [12, 30]), ("figure", [13])]


def test_keeps_page_numbers_inside_the_chunk() -> None:
    chunk = ChunkIndex(
        summary="s",
        sections=[Section(title="A", level=7, start_page=19, end_page=99, summary="")],
        entries=[Entry(kind="term", name="x", description="", pages=[0, 25])],
        references=[],
    )
    clamped = clamp_chunk(chunk, 21, 40)
    assert (clamped.sections[0].start_page, clamped.sections[0].end_page) == (21, 40)
    assert clamped.sections[0].level == 4
    assert clamped.entries[0].pages == [21, 25]


@pytest.fixture
def library(tmp_path):
    return Library(tmp_path)


async def test_indexes_a_document_with_text_and_scanned_pages(library, tmp_path) -> None:
    pages = [filler(f"topic {n}") for n in range(1, 25)]
    pages[21] = []  # page 22 is "scanned"
    doc = await library.add(make_pdf(pages), "book.pdf")

    def respond(kwargs):
        if kwargs["output_format"] is DocSummary:
            return DocSummary(title="A Book", kind="textbook", summary="About topics.")
        content = kwargs["messages"][0]["content"]
        start = 1 if any("PDF page 1 " in b.get("text", "") for b in content) else 21
        return ChunkIndex(
            summary=f"Pages from {start}.",
            sections=[
                Section(
                    title=f"Part {start}",
                    level=1,
                    start_page=start,
                    end_page=start + 3,
                    summary="s",
                )
            ],
            entries=[Entry(kind="term", name=f"term {start}", description="d", pages=[start])],
            references=[],
        )

    client = FakeIndexClient(respond)
    usage = UsageLog(tmp_path / "usage.jsonl")
    indexer = Indexer(library, usage, lambda: client)
    index = await indexer.index(doc.id)

    assert index.complete and index.title == "A Book" and index.kind == "textbook"
    assert [c.start_page for c in index.chunks] == [1, 21]
    assert index.scanned_pages == [22]
    assert [s.title for s in index.sections] == ["Part 1", "Part 21"]
    # Text pages go as text, the scanned page as an image, all with PDF page headers.
    second = next(r for r in client.requests if "PDF page 21 " in str(r["messages"]))
    kinds = [b["type"] for b in second["messages"][0]["content"]]
    assert kinds.count("image") == 1
    assert client.requests[0]["model"] == "claude-haiku-5-5"
    calls = usage.summary()
    assert calls["index_chunk"]["calls"] == 2
    assert calls["index_chunk"]["image_pages"] == 1
    assert indexer.doc_status(doc.id)["status"] == "ready"
    # Saved: a new indexer finds it without indexing again.
    assert Indexer(library, usage, lambda: None).doc_status(doc.id)["status"] == "ready"
    assert "Part 21 [pp. 21–24]" in render_outline(doc, index)


async def test_reports_a_missing_api_key_as_an_indexing_error(library, tmp_path) -> None:
    doc = await library.add(make_pdf([filler("x")]), "a.pdf")
    indexer = Indexer(library, UsageLog(None), lambda: None)
    indexer.enqueue(doc.id)
    for _ in range(50):
        await asyncio.sleep(0.01)
        if indexer.doc_status(doc.id)["status"] == "error":
            break
    status = indexer.doc_status(doc.id)
    assert status["status"] == "error"
    assert "ANTHROPIC_API_KEY" in status["error"]


async def test_resumes_a_half_indexed_document_after_a_restart(library, tmp_path) -> None:
    doc = await library.add(make_pdf([filler("x")]), "a.pdf")
    # A fresh indexer, as after the backend restarted mid-index: nothing is queued.
    indexer = Indexer(library, UsageLog(None), lambda: None)
    indexer.resume(doc.id)
    assert indexer.doc_status(doc.id)["status"] == "queued"
    for _ in range(50):
        await asyncio.sleep(0.01)
        if indexer.doc_status(doc.id)["status"] == "error":
            break
    # It ran (and failed here for want of a key); asking again does not retry a failure.
    assert indexer.doc_status(doc.id)["status"] == "error"
    indexer.resume(doc.id)
    assert indexer.doc_status(doc.id)["status"] == "error"


async def test_an_index_made_before_kinds_gets_its_kind_and_keeps_its_summary(
    library, tmp_path
) -> None:
    doc = await library.add(make_pdf([filler("x")]), "exam.pdf")

    def respond(kwargs):
        assert kwargs["output_format"] is DocSummary  # no page is indexed again
        return DocSummary(title="New title", kind="exam", summary="New summary.")

    client = FakeIndexClient(respond)
    indexer = Indexer(library, UsageLog(None), lambda: client)
    old = DocIndex(
        doc_id=doc.id,
        title="Exam",
        summary="An exam.",
        page_count=1,
        labels=[None],
        chunks=[ChunkRecord(start_page=1, end_page=1, summary="Q1.")],
        complete=True,
    )
    indexer._save(old)
    indexer.enqueue(doc.id)
    for _ in range(50):
        await asyncio.sleep(0.01)
        if indexer.get(doc.id).kind:
            break
    index = indexer.get(doc.id)
    assert (index.kind, index.title, index.summary) == ("exam", "Exam", "An exam.")
    assert indexer.doc_status(doc.id)["status"] == "ready"
    # Once it has a kind it is not queued again.
    indexer.enqueue(doc.id)
    assert len(client.requests) == 1


async def wait_for_error(indexer: Indexer, doc_id: str) -> None:
    for _ in range(50):
        await asyncio.sleep(0.01)
        if indexer.doc_status(doc_id)["status"] == "error":
            return


async def test_a_failure_is_tried_again_a_few_times_and_whenever_the_reader_asks(
    library, tmp_path
) -> None:
    doc = await library.add(make_pdf([filler("x")]), "a.pdf")
    indexer = Indexer(library, UsageLog(None), lambda: None)
    indexer.enqueue(doc.id)
    await wait_for_error(indexer, doc.id)
    for _ in range(AUTO_RETRIES):
        # As if the failure was a while ago.
        indexer.status[doc.id]["failed_at"] -= RETRY_AFTER_SECONDS
        indexer.resume(doc.id)
        assert indexer.doc_status(doc.id)["status"] == "queued"
        await wait_for_error(indexer, doc.id)
    indexer.status[doc.id]["failed_at"] -= RETRY_AFTER_SECONDS
    indexer.resume(doc.id)
    assert indexer.doc_status(doc.id)["status"] == "error"
    indexer.retry(doc.id)
    assert indexer.doc_status(doc.id)["status"] == "queued"


async def test_a_damaged_index_file_is_indexed_again(library, tmp_path) -> None:
    doc = await library.add(make_pdf([filler("x")]), "a.pdf")
    indexer = Indexer(library, UsageLog(None), lambda: None)
    indexer.index_path(doc.id).write_text('{"doc_id": "')
    assert indexer.get(doc.id) is None
    assert indexer.doc_status(doc.id)["status"] == "queued"


async def test_damaged_pages_are_read_again_from_the_pdf(tmp_path) -> None:
    doc = await Library(tmp_path).add(make_pdf([filler("limits")]), "a.pdf")
    (tmp_path / "docs" / doc.id / "pages.json").write_text('{"id": ')
    again = Library(tmp_path).get(doc.id)
    assert again is not None and "limits" in again.pages[0].text
    assert Library(tmp_path).get("../docs") is None
