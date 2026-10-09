import pytest
from pdfs import filler, make_pdf

from doc_digest.library import Library, garbled, page_name

LABELS = "<< /Nums [0 << /S /r >> 2 << /S /D /St 1 >>] >>"


@pytest.fixture
def library(tmp_path):
    return Library(tmp_path)


async def test_reads_text_labels_and_bookmarks(library) -> None:
    data = make_pdf(
        [filler("limits"), [], filler("the chain rule")],
        labels=LABELS,
        bookmarks=[("1 Limits", 1), ("2 Derivatives", 3)],
    )
    doc = await library.add(data, "calc.pdf")
    assert doc.page_count == 3
    assert [p.label for p in doc.pages] == ["i", "ii", "1"]
    assert [p.scanned for p in doc.pages] == [False, True, False]
    assert "chain rule" in doc.pages[2].text
    assert [(b.title, b.page) for b in doc.bookmarks] == [("1 Limits", 1), ("2 Derivatives", 3)]
    assert page_name(doc, 3) == 'p. 3 (printed "1")'


async def test_stores_each_pdf_once_and_reloads_it(library, tmp_path) -> None:
    data = make_pdf([filler("limits")])
    first = await library.add(data, "a.pdf")
    again = await library.add(data, "a.pdf")
    assert first.id == again.id
    assert len(list((tmp_path / "docs").iterdir())) == 1
    assert Library(tmp_path).get(first.id).pages[0].text == first.pages[0].text


async def test_renders_pages_as_jpeg(library) -> None:
    doc = await library.add(make_pdf([[], filler("x")]), "a.pdf")
    image = await library.render(doc.id, 1, 400)
    assert image[:3] == b"\xff\xd8\xff"


def test_garbled_text_is_mostly_unreadable_characters() -> None:
    assert garbled("��� ab")
    assert not garbled("An ordinary sentence.")
