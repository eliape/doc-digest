from leqtern.costs import questions, report
from leqtern.usage import Call


def call(kind: str, at: float, cache_write: int, cache_read: int, cost: float, **extra) -> Call:
    model = extra.pop("model", "claude-opus-5-5")
    return Call(
        kind=kind,
        model=model,
        input=4,
        output=200,
        cache_write=cache_write,
        cache_read=cache_read,
        seconds=3.0,
        cost=cost,
        at=at,
        **extra,
    )


def test_lookup_rounds_count_as_one_question() -> None:
    calls = [
        call("answer", 0, 7000, 0, 0.04),
        call("answer", 3, 1200, 7000, 0.01),  # a lookup round rereads everything before it
        call("answer", 60, 6000, 1900, 0.03),  # a new question rereads only the history
        call("answer", 400, 7000, 0, 0.04),
    ]
    assert [len(q) for q in questions(calls)] == [2, 1, 1]


def test_report_sums_questions_quizzes_and_indexing() -> None:
    calls = [
        call("index_chunk", 0, 0, 0, 0.003, model="claude-haiku-5-5", doc_id="abc"),
        call("answer", 10, 7000, 0, 0.04),
        call("answer", 13, 1200, 7000, 0.02),
        call("answer", 100, 6000, 1900, 0.03),
        call("quiz", 200, 3000, 0, 0.025, model="claude-sonnet-5-5"),
        call("quiz_recommendation", 300, 0, 0, 0.0002, model="claude-haiku-5-5"),
    ]
    text = report(calls, {"abc": ("book.pdf", 640)})
    assert "Opus 5.5: 2 questions, 4.5¢ each on average" in text
    assert "with lookups: 1, 6.0¢ each" in text
    assert "Quizzes\n  Sonnet 5.5: 1, 2.5¢ each" in text
    assert "Haiku 5.5: 1, 0.02¢ each" in text
    assert "book.pdf, 640 pages: 0.3¢" in text


def test_report_without_calls() -> None:
    assert report([]) == "No API calls in that period."
