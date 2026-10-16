from types import SimpleNamespace

from leqtern.costs import questions, report
from leqtern.usage import Call, call_from_response


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


def test_calls_with_a_question_id_are_grouped_by_it() -> None:
    calls = [
        call("answer", 0, 7000, 0, 0.04, question="a", round=0),
        # Long after, and reading nothing: the old guess would call this a new question.
        call("answer", 500, 1200, 0, 0.01, question="a", round=1),
        call("answer", 501, 6000, 7000, 0.03, question="b", round=0),
    ]
    assert [len(q) for q in questions(calls)] == [2, 1]


def test_report_splits_questions_by_effort() -> None:
    calls = [
        call("answer", 0, 7000, 0, 0.02, question="a", effort="low"),
        call("answer", 100, 7000, 0, 0.04, question="b", effort="low"),
        call("answer", 200, 7000, 0, 0.09, question="c", effort="high"),
        call("answer", 300, 7000, 0, 0.05),  # logged before effort was
    ]
    text = report(calls, by="effort")
    assert "Questions by effort\n  Opus 5.5\n" in text
    assert "    high: 1, 9.0¢ each (9.0¢ in all)" in text
    assert "    low: 2, 3.0¢ each (6.0¢ in all)" in text
    assert "    unknown: 1, 5.0¢ each" in text


def test_report_counts_cache_writes_nobody_read() -> None:
    calls = [
        call("answer", 0, 7000, 0, 0.04),
        call("answer", 60, 3000, 7000, 0.02),  # reads the first write
        call("answer", 1000, 5000, 0, 0.03),  # the second write expired unread
        call("answer", 1100, 0, 4000, 0.01),  # reads the third
    ]
    text = report(calls)
    assert "Opus 5.5: 2 of 4 calls read from the cache; 3,000 of 15,000 tokens written" in text


def test_a_fallback_is_logged_and_priced_as_the_model_that_answered() -> None:
    usage = SimpleNamespace(
        input_tokens=1_000_000,
        output_tokens=0,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
    )
    response = SimpleNamespace(usage=usage, model="claude-sonnet-5-5", stop_reason="end_turn")
    fell_back = call_from_response("answer", "claude-opus-5-5", response, 1.0)
    assert fell_back.served_model == "claude-sonnet-5-5"
    assert fell_back.cost == 2.0
    response.model = "claude-opus-5-5-20261001"
    assert call_from_response("answer", "claude-opus-5-5", response, 1.0).served_model is None
    assert "Opus 5.5 fell back to Sonnet 5.5: 1, $2.00 in all" in report([fell_back])


def test_old_log_lines_still_load(tmp_path) -> None:
    from leqtern.usage import UsageLog

    log = tmp_path / "usage.jsonl"
    log.write_text(
        '{"kind": "answer", "model": "claude-opus-5-5", "input": 1, "output": 2, '
        '"cache_write": 0, "cache_read": 0, "seconds": 1.0, "cost": 0.01, "at": 5}\n'
    )
    [old] = UsageLog(log).calls
    assert old.effort is None and old.tools == []
