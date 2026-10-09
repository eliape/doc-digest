from fakes import FakeAnswerClient, FakeIndexClient, text, tool_use
from pdfs import filler, make_pdf

from doc_digest.evaluate import Question, cited_pages, evaluate
from doc_digest.index import ChunkIndex, DocSummary


def test_reads_page_citations() -> None:
    answer = "See (book.pdf, p. 4) and (book.pdf, pp. 7–9), not (other.pdf, p. 2)."
    assert cited_pages(answer, "book.pdf") == {4, 7, 8, 9}


async def test_reports_whether_the_expected_pages_were_read(tmp_path) -> None:
    book = tmp_path / "book.pdf"
    book.write_bytes(make_pdf([filler("limits"), filler("derivatives"), []]))
    notes = tmp_path / "notes.pdf"
    notes.write_bytes(make_pdf([filler("homework")]))

    def respond(kwargs):
        if kwargs["output_format"] is DocSummary:
            return DocSummary(title="T", summary="S")
        return ChunkIndex(summary="s", sections=[], entries=[], references=[])

    index_client = FakeIndexClient(respond)
    answers = FakeAnswerClient(
        [
            ([tool_use("t1", "read_pages", {"doc": "D1", "pages": [2]})], "tool_use"),
            ([text("Derivatives are slopes (book.pdf, p. 2).")], "end_turn"),
        ]
    )
    questions = [
        Question.model_validate(
            {
                "question": "What is a derivative?",
                "open": {"doc": "notes.pdf", "page": 1},
                "expect": [{"doc": "book.pdf", "pages": [2]}],
            }
        )
    ]
    report = await evaluate(
        [book, notes],
        questions,
        tmp_path / "data",
        answers,
        lambda: index_client,
        log=lambda _: None,
    )

    [result] = report["questions"]
    assert result["found"] and result["cited_expected"]
    assert result["pages_read"] == [("book.pdf", 2)]
    assert result["usage"]["calls"] == 2
    assert report["summary"]["found"] == 1
    docs = {d["doc"]: d for d in report["indexing"]["documents"]}
    assert docs["book.pdf"]["scanned_pages"] == 1
    assert set(report["indexing"]["chunks"]) == {"mixed", "text"}
    # The question was asked from notes.pdf, with the book in the topic too.
    assert "notes.pdf" in str(answers.requests[0]["messages"][0])
