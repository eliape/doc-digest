import pytest
from fakes import FakeAnswerClient, text, tool_use
from pdfs import filler, make_pdf

from doc_digest.ask import AskRequest, Turn, stream_answer
from doc_digest.index import ChunkRecord, DocIndex, Entry, Section
from doc_digest.library import Library
from doc_digest.tools import Toolbox, ToolError, TopicDoc, overview, terms
from doc_digest.usage import UsageLog


@pytest.fixture
async def topic(tmp_path):
    library = Library(tmp_path)
    slides = await library.add(
        make_pdf(
            [filler("lecture outline"), ["Slide: the chain rule", "f(g(x))' = f'(g(x)) g'(x)"]]
        ),
        "slides.pdf",
    )
    book_pages = [filler(f"chapter material {n}") for n in range(1, 6)]
    book_pages[3] = filler("the chain rule for composite functions and its proof")
    book_pages[4] = []  # scanned
    book = await library.add(make_pdf(book_pages), "book.pdf")
    book_index = DocIndex(
        doc_id=book.id,
        title="Calculus",
        summary="An introductory calculus book.",
        page_count=5,
        labels=[None] * 5,
        scanned_pages=[5],
        chunks=[ChunkRecord(start_page=1, end_page=5, summary="All of it.")],
        sections=[
            Section(title="1 Limits", level=1, start_page=1, end_page=3, summary="Limits."),
            Section(title="2 Derivatives", level=1, start_page=4, end_page=5, summary="Rates."),
            Section(title="2.1 Chain rule", level=2, start_page=4, end_page=4, summary="Proof."),
        ],
        entries=[
            Entry(
                kind="definition", name="derivative", description="limit of quotients", pages=[4]
            ),
            Entry(kind="figure", name="Figure 2.1", description="tangent line", pages=[5]),
        ],
        complete=True,
    )
    docs = [
        TopicDoc("D1", slides, None, {"status": "indexing", "pages_done": 0}),
        TopicDoc("D2", book, book_index, {"status": "ready"}),
    ]
    return Toolbox(library, docs)


def test_terms_drops_stopwords_and_endings() -> None:
    assert terms("What are the derivatives of composed functions?") == [
        "derivative",
        "compos",
        "function",
    ]
    assert terms("processes boxes analysis studies") == [
        "process",
        "box",
        "analysis",
        "study",
    ]


async def test_search_finds_index_entries_and_page_text(topic) -> None:
    result = await topic.run("search", {"query": "chain rule"})
    assert "[D2] Section “2.1 Chain rule”, p. 4: Proof." in result
    assert "[D2] p. 4:" in result
    assert "[D1] p. 2:" in result  # unindexed documents are still searched by text
    assert "Not fully indexed yet: D1" in result


async def test_search_can_be_limited_to_documents(topic) -> None:
    result = await topic.run("search", {"query": "chain rule", "docs": ["d1"]})
    assert "[D2]" not in result


async def test_outline_shows_sections_and_entries(topic) -> None:
    result = await topic.run("get_outline", {"doc": "D2"})
    assert "Calculus. An introductory calculus book." in result
    assert "  - 2.1 Chain rule [p. 4]" in result
    assert "- Figure 2.1 (pp. 5): tangent line" in result
    unindexed = await topic.run("get_outline", {"doc": "D1"})
    assert "not been indexed yet" in unindexed


async def test_reads_text_pages_as_text_and_scanned_pages_as_images(topic) -> None:
    blocks = await topic.run("read_pages", {"doc": "D2", "pages": [4, 5]})
    assert [b["type"] for b in blocks] == ["text", "text", "image"]
    assert "composite functions" in blocks[0]["text"]
    with_images = await topic.run("read_pages", {"doc": "D2", "pages": [4], "images": True})
    assert [b["type"] for b in with_images] == ["text", "image", "text"]
    assert topic.pages_read == [("D2", 4), ("D2", 5), ("D2", 4)]


async def test_tells_the_model_what_went_wrong(topic) -> None:
    with pytest.raises(ToolError, match="no document 'D9'.*D1 \\(slides.pdf\\)"):
        await topic.run("read_pages", {"doc": "D9", "pages": [1]})
    with pytest.raises(ToolError, match="pages 1–5; not \\[9\\]"):
        await topic.run("read_pages", {"doc": "D2", "pages": [9]})
    with pytest.raises(ToolError, match="Invalid input"):
        await topic.run("read_pages", {"doc": "D2"})


async def test_describes_lookups_for_the_chat(topic) -> None:
    assert topic.describe("search", {"query": "chain rule"}) == "Searched for “chain rule”"
    assert topic.describe("read_pages", {"doc": "D2", "pages": [5, 4]}) == "Read book.pdf, pp. 4–5"


async def test_overview_is_compact(topic) -> None:
    text = overview(list(topic.docs.values()), current="D2")
    assert "D1: slides.pdf (2 pages, indexing: 0 of 2 pages done, 1 pages scanned" in text
    assert "D2: book.pdf (5 pages, indexed, 1 pages scanned or without text) — open now" in text
    assert "    - 2.1 Chain rule [p. 4]" in text  # level 2 shown for the open document
    assert "derivative" not in text  # entries stay behind the tools


async def test_answers_after_looking_things_up(topic, tmp_path) -> None:
    client = FakeAnswerClient(
        [
            ([tool_use("t1", "search", {"query": "chain rule"})], "tool_use"),
            ([tool_use("t2", "read_pages", {"doc": "D2", "pages": [4]})], "tool_use"),
            ([text("It is proved on p. 4 (book.pdf, p. 4).")], "end_turn"),
        ]
    )
    usage = UsageLog(tmp_path / "u.jsonl")
    request = AskRequest(
        topic="Calc", docs=[], messages=[Turn(role="user", text="Where is the proof?")]
    )
    events = [e async for e in stream_answer(client, request, topic, usage)]

    assert [e["type"] for e in events] == ["step", "step", "text", "done"]
    assert events[0]["text"] == "Searched for “chain rule”"
    assert events[1]["text"] == "Read book.pdf, p. 4"
    assert events[-1]["pages_read"] == ["D2 p. 4"]
    # Each round sends the tool results back after the model's turn.
    last = client.requests[-1]["messages"]
    assert [m["role"] for m in last] == ["user", "assistant", "user", "assistant", "user"]
    assert last[-1]["content"][0]["type"] == "tool_result"
    assert "D2: book.pdf" in client.requests[0]["system"][1]["text"]
    assert usage.summary()["answer"]["calls"] == 3


async def test_bad_tool_calls_come_back_as_errors(topic) -> None:
    client = FakeAnswerClient(
        [
            ([tool_use("t1", "read_pages", {"doc": "D7", "pages": [1]})], "tool_use"),
            ([text("Sorry.")], "end_turn"),
        ]
    )
    request = AskRequest(topic="Calc", messages=[Turn(role="user", text="?")])
    _ = [e async for e in stream_answer(client, request, topic)]
    result = client.requests[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True
    assert "no document 'D7'" in result["content"]


async def test_must_answer_after_the_last_round(topic, monkeypatch) -> None:
    monkeypatch.setattr("doc_digest.ask.MAX_ROUNDS", 2)
    client = FakeAnswerClient(
        [
            ([tool_use("t1", "search", {"query": "x"})], "tool_use"),
            ([text("Done.")], "end_turn"),
        ]
    )
    request = AskRequest(topic="Calc", messages=[Turn(role="user", text="?")])
    _ = [e async for e in stream_answer(client, request, topic)]
    assert client.requests[-1]["tool_choice"] == {"type": "none"}
