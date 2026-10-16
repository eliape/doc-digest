from types import SimpleNamespace

from fakes import usage

from leqtern.costs import questions, report, unread_writes
from leqtern.usage import Call, call_from_response, cost


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


def test_logged_rounds_group_questions_without_guessing() -> None:
    calls = [
        call("answer", 0, 7000, 0, 0.04, chat_id="a", round_no=0),
        # Long after, and reading little from the cache: still a lookup round of the question.
        call("answer", 500, 1200, 10, 0.01, chat_id="a", round_no=1),
        call("answer", 510, 6000, 6000, 0.03, chat_id="a", round_no=0),
    ]
    assert [len(q) for q in questions(calls)] == [2, 1]


def test_report_splits_questions_by_effort() -> None:
    calls = [
        call("answer", 0, 7000, 0, 0.04, effort="low", round_no=0),
        call("answer", 100, 7000, 0, 0.02, effort="low", round_no=0),
        call("answer", 200, 7000, 0, 0.08, effort="high", round_no=0),
        call("answer", 210, 0, 7000, 0.02, effort="high", round_no=1),
    ]
    text = report(calls)
    assert "Opus 5.5, low: 2, 3.0¢ each, 200 output tokens each" in text
    assert "Opus 5.5, high: 1, 10.0¢ each, 400 output tokens each" in text


def test_cache_writes_count_as_read_only_if_the_next_call_reads_in_time() -> None:
    answers = [
        call("answer", 0, 7000, 0, 0.04, chat_id="a"),
        call("answer", 60, 2000, 7000, 0.02, chat_id="a"),  # reads the first write
        call("answer", 1000, 3000, 0, 0.02, chat_id="a"),  # too late: the second write expired
        call("answer", 1010, 5000, 0, 0.02, chat_id="b"),  # never followed
    ]
    written, unread, extra = unread_writes(answers)
    assert written == 17000
    assert unread == 10000  # all but the first write
    assert round(extra, 6) == round(10000 * 4.00 / 1e6 * 0.25, 6)
    text = report(answers)
    assert "Opus 5.5: 1 of 4 calls read from the cache" in text
    assert "cache writes never read: 59% of 17000 tokens written" in text


def test_report_counts_why_answers_ended_and_fallbacks() -> None:
    calls = [
        call("answer", 0, 0, 0, 0.01, stop_reason="end_turn"),
        call("answer", 10, 0, 0, 0.01, stop_reason="end_turn"),
        call("answer", 20, 0, 0, 0.01, stop_reason="max_tokens"),
        call("answer", 30, 0, 0, 0.01, stopped=True),
        call("answer", 40, 0, 0, 0.01, served_model="claude-sonnet-5-5", stop_reason="end_turn"),
    ]
    text = report(calls)
    assert (
        "Why answer calls ended\n  end_turn: 3\n  max_tokens: 1\n  stopped by the reader: 1" in text
    )
    assert "Fallbacks to another model\n  Opus 5.5 -> Sonnet 5.5: 1, 1.0¢" in text
    assert "Sonnet 5.5: 0 of 1 calls read from the cache" in text


def test_a_fallback_is_logged_and_priced_as_the_model_that_answered() -> None:
    response = SimpleNamespace(
        model="claude-sonnet-5-5", usage=usage(1000, 100), stop_reason="end_turn"
    )
    logged = call_from_response("answer", "claude-opus-5-5", response, 2.0)
    assert logged.served_model == "claude-sonnet-5-5"
    assert logged.cost == cost("claude-sonnet-5-5", 1000, 100, 0, 0)
    assert logged.stop_reason == "end_turn"
    # The same model under a dated id is no fallback.
    dated = SimpleNamespace(model="claude-opus-5-5-20261001", usage=usage(), stop_reason=None)
    assert call_from_response("answer", "claude-opus-5-5", dated, 1.0).served_model is None
    assert cost("claude-opus-5-5-20261001", 1000, 0, 0, 0) == cost("claude-opus-5-5", 1000, 0, 0, 0)
