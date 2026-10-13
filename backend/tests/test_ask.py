import json

import pytest
from fakes import FakeIndexClient
from fastapi.testclient import TestClient

from leqtern import main
from leqtern.ask import (
    QUIZ_SECTION,
    QUIZ_START,
    SOCRATIC_END,
    SOCRATIC_START,
    SYSTEM_PROMPT,
    AskRequest,
    Context,
    Point,
    Turn,
    build_messages,
    describe,
    write_quiz,
)
from leqtern.config import Settings, get_settings
from leqtern.quiz import Quiz, QuizQuestion, QuizRecord, Recommendation


def context(**overrides: object) -> Context:
    fields: dict[str, object] = {"doc_name": "notes.pdf", "page": 12}
    fields.update(overrides)
    return Context.model_validate(fields)


def test_describe_a_click_names_the_page_and_spot() -> None:
    text = describe(context(page_label="xii", point=Point(x=0.25, y=0.5), section="Integrals"))
    assert text == (
        'They clicked a spot on p. 12 (printed as "xii") of notes.pdf, in "Integrals" '
        "(25% across, 50% down the page)."
    )


def test_describe_a_selection_quotes_it() -> None:
    assert describe(context(page_label="12", selection="dx/dt")) == (
        "They selected this text on p. 12 of notes.pdf:\ndx/dt"
    )


def test_only_the_newest_question_carries_images() -> None:
    with_images = {"page_image": "PAGE", "point": {"x": 0.1, "y": 0.2}}
    request = AskRequest(
        topic="Calculus",
        messages=[
            Turn(role="user", text="first?", context=context(**with_images)),
            Turn(role="assistant", text="An answer."),
            Turn(role="user", text="second?", context=context(page=13, **with_images)),
        ],
    )
    messages = build_messages(request)
    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    first, _, last = messages
    assert [b["type"] for b in first["content"]] == ["text", "text"]
    assert first["content"][-1]["text"] == "Question: first?"
    images = [b["source"]["data"] for b in last["content"] if b["type"] == "image"]
    assert images == ["PAGE"]
    assert last["content"][-1]["text"] == "Question: second?"


def test_the_history_before_the_newest_question_is_cached() -> None:
    request = AskRequest(
        topic="T",
        messages=[
            Turn(role="user", text="one"),
            Turn(role="assistant", text="first answer"),
            Turn(role="user", text="two"),
            Turn(role="assistant", text="second answer"),
            Turn(role="user", text="three"),
        ],
    )
    messages = build_messages(request)
    marked = [b["text"] for m in messages for b in m["content"] if "cache_control" in b]
    assert marked == ["second answer"]


def test_a_band_across_a_page_break_names_both_pages() -> None:
    ctx = context(
        page_image="BAND",
        point={"x": 0.5, "y": 0.1},
        image_pages=[11, 12],
        page_texts=[{"page": 11, "label": "x", "text": "end"}, {"page": 12, "text": "start"}],
    )
    request = AskRequest(topic="T", messages=[Turn(role="user", text="?", context=ctx)])
    texts = [b["text"] for b in build_messages(request)[0]["content"] if b["type"] == "text"]
    assert 'Around where they pointed, marked in red (p. 11 (printed as "x") into p. 12):' in texts
    assert 'Text the PDF has on the part of p. 11 (printed as "x") in the image:\nend' in texts


def test_long_page_text_is_cut() -> None:
    page = {"page": 12, "text": "x" * 5000}
    request = AskRequest(
        topic="T", messages=[Turn(role="user", text="?", context=context(page_texts=[page]))]
    )
    texts = [b["text"] for b in build_messages(request)[0]["content"]]
    page_text = next(t for t in texts if t.startswith("Text the PDF has on"))
    assert page_text.endswith("x …")
    assert len(page_text) < 3100


def test_a_question_without_context_is_sent_as_typed() -> None:
    request = AskRequest(topic="T", messages=[Turn(role="user", text="hi")])
    assert build_messages(request) == [
        {"role": "user", "content": [{"type": "text", "text": "hi"}]}
    ]


def test_failed_answers_do_not_leave_two_questions_in_a_row() -> None:
    request = AskRequest(
        topic="T",
        messages=[
            Turn(role="user", text="one"),
            Turn(role="assistant", text=""),
            Turn(role="user", text="two"),
        ],
    )
    messages = build_messages(request)
    assert len(messages) == 1
    assert [b["text"] for b in messages[0]["content"]] == ["one", "two"]


def test_a_socratic_session_starts_from_a_spot_and_marks_its_turns() -> None:
    spot = context(point=Point(x=0.5, y=0.5), page_image="PAGE")
    request = AskRequest(
        topic="T",
        messages=[
            Turn(role="user", text="", context=spot, mode="socratic"),
            Turn(role="assistant", text="What does dx stand for here?"),
            Turn(role="user", text=" A small change in x? ", mode="socratic"),
            Turn(role="assistant", text="Right. So what is dy/dx?"),
            Turn(role="user", text="What is a derivative?"),
            Turn(role="assistant", text="A rate of change."),
            Turn(role="user", text="And an integral?"),
        ],
    )
    messages = build_messages(request)
    first, _, reply, _, after, _, later = messages
    # The reader only pointed at something, so the first turn asks for the first question.
    assert first["content"][0]["text"].startswith("They clicked a spot on p. 12")
    assert first["content"][-1]["text"] == f"[Socratic] {SOCRATIC_START}"
    assert reply["content"][-1]["text"] == "[Socratic] A small change in x?"
    # Switching back to Normal tells the model to stop questioning; then questions are plain.
    assert after["content"][-1]["text"] == f"{SOCRATIC_END}\nWhat is a derivative?"
    assert later["content"][-1]["text"] == "And an integral?"
    assert "[Socratic]" in SYSTEM_PROMPT and "[Socratic session ended]" in SYSTEM_PROMPT


@pytest.fixture
def client():
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def lines(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines()]


def test_ask_without_an_api_key_says_how_to_add_one(client: TestClient) -> None:
    main.app.dependency_overrides[get_settings] = lambda: Settings(anthropic_api_key=None)
    response = client.post(
        "/api/ask", json={"topic": "T", "messages": [{"role": "user", "text": "hi"}]}
    )
    assert response.status_code == 503
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_ask_streams_events_as_json_lines(client: TestClient, monkeypatch) -> None:
    async def fake_stream(_client, request, toolbox, _usage, _model, **_):
        assert request.messages[-1].text == "hi"
        assert toolbox.docs == {}
        yield {"type": "step", "text": "Searched for “x”"}
        yield {"type": "text", "text": "Hel"}
        yield {"type": "text", "text": "lo"}
        yield {"type": "done"}

    main.app.dependency_overrides[main.get_client] = lambda: object()
    monkeypatch.setattr(main, "stream_answer", fake_stream)
    response = client.post(
        "/api/ask", json={"topic": "T", "messages": [{"role": "user", "text": "hi"}]}
    )
    assert response.status_code == 200
    assert lines(response) == [
        {"type": "step", "text": "Searched for “x”"},
        {"type": "text", "text": "Hel"},
        {"type": "text", "text": "lo"},
        {"type": "done"},
    ]


def test_ask_reports_a_failure_in_the_stream(client: TestClient, monkeypatch) -> None:
    async def failing_stream(_client, _request, _toolbox, _usage, _model, **_):
        yield {"type": "text", "text": "Par"}
        raise RuntimeError("boom")

    main.app.dependency_overrides[main.get_client] = lambda: object()
    monkeypatch.setattr(main, "stream_answer", failing_stream)
    response = client.post(
        "/api/ask", json={"topic": "T", "messages": [{"role": "user", "text": "hi"}]}
    )
    assert lines(response) == [
        {"type": "text", "text": "Par"},
        {"type": "error", "message": "Something went wrong while answering."},
    ]


def test_ask_uses_the_chosen_model_or_the_default(client: TestClient, monkeypatch) -> None:
    used: list[str] = []

    async def fake_stream(_client, _request, _toolbox, _usage, model, **_):
        used.append(model)
        yield {"type": "done"}

    main.app.dependency_overrides[main.get_client] = lambda: object()
    monkeypatch.setattr(main, "stream_answer", fake_stream)
    question = {"topic": "T", "messages": [{"role": "user", "text": "hi"}]}
    client.post("/api/ask", json={**question, "model": "claude-sonnet-5-5"})
    client.post("/api/ask", json=question)
    assert used == ["claude-sonnet-5-5", main.get_settings().answer_model]

    # Only the models offered in the chat are accepted.
    response = client.post("/api/ask", json={**question, "model": "some-other-model"})
    assert response.status_code == 422


def test_ask_accepts_socratic_and_quiz_turns_only(client: TestClient, monkeypatch) -> None:
    modes: list[str | None] = []

    async def fake_stream(_client, request, _toolbox, _usage, _model, **_):
        modes.append(request.messages[-1].mode)
        yield {"type": "done"}

    main.app.dependency_overrides[main.get_client] = lambda: object()
    monkeypatch.setattr(main, "stream_answer", fake_stream)
    turn = {"role": "user", "text": ""}
    client.post("/api/ask", json={"topic": "T", "messages": [{**turn, "mode": "socratic"}]})
    assert modes == ["socratic"]
    response = client.post("/api/ask", json={"topic": "T", "messages": [{**turn, "mode": "exam"}]})
    assert response.status_code == 422


def test_a_socratic_session_can_start_with_what_to_focus_on() -> None:
    spot = context(point=Point(x=0.5, y=0.5))
    request = AskRequest(
        topic="T",
        messages=[
            Turn(role="user", text="the limit", context=spot, mode="socratic"),
            Turn(role="assistant", text="What happens as h gets small?"),
            Turn(role="user", text="It goes to zero", mode="socratic"),
        ],
    )
    first, _, reply = build_messages(request)
    assert first["content"][-1]["text"] == f"[Socratic] {SOCRATIC_START} Focus on: the limit"
    # Later turns in the session are their answers.
    assert reply["content"][-1]["text"] == "[Socratic] It goes to zero"


def quiz(**overrides: object) -> QuizRecord:
    fields: dict[str, object] = {
        "title": "Derivatives",
        "questions": [
            QuizQuestion(
                question="What is f'(x) for x^2?",
                choices=["x", "2x", "x^2"],
                answer=1,
                explanation="The power rule (notes.pdf, p. 12).",
            ),
            QuizQuestion(
                question="What does dx stand for?",
                choices=["A small change in x", "A constant"],
                answer=0,
                explanation="An infinitesimal change.",
            ),
        ],
    }
    fields.update(overrides)
    return QuizRecord.model_validate(fields)


def test_a_quiz_request_is_marked_and_says_what_to_focus_on() -> None:
    spot = context(point=Point(x=0.5, y=0.5), page_image="PAGE")
    plain = AskRequest(topic="T", messages=[Turn(role="user", text="", context=spot, mode="quiz")])
    # With nothing to focus on, the quiz covers the section they are reading.
    assert build_messages(plain)[0]["content"][-1]["text"] == f"[Quiz] {QUIZ_SECTION}"
    focused = AskRequest(
        topic="T", messages=[Turn(role="user", text="the chain rule", context=spot, mode="quiz")]
    )
    content = build_messages(focused)[0]["content"]
    assert content[-1]["text"] == f"[Quiz] {QUIZ_START} Focus on: the chain rule"
    # The newest request carries the images, like a question.
    assert any(b["type"] == "image" for b in content)
    assert "[Quiz]" in SYSTEM_PROMPT and "[Quiz results]" in SYSTEM_PROMPT


def test_a_quiz_and_how_they_did_go_into_the_history() -> None:
    taken = quiz(picked=[0, 0], recommendation="Read the power rule again (notes.pdf, p. 12).")
    request = AskRequest(
        topic="T",
        messages=[
            Turn(role="user", text="", context=context(), mode="quiz"),
            Turn(role="assistant", text="", quiz=taken),
            Turn(role="user", text="Why is it 2x?"),
        ],
    )
    _, written, after = build_messages(request)
    text = written["content"][0]["text"]
    assert text.startswith("[Quiz] Derivatives")
    assert "   B) 2x" in text and "Right answer: B. The power rule (notes.pdf, p. 12)." in text
    # The results are on the reader's side, before their next question.
    results, question = (b["text"] for b in after["content"])
    assert results.splitlines() == [
        "[Quiz results] They got 1 of 2 right.",
        "1. Wrong: they chose A) x; the answer is B) 2x.",
        "2. Right.",
        "They were advised: Read the power rule again (notes.pdf, p. 12).",
    ]
    assert question == "Why is it 2x?"


def test_an_unanswered_quiz_has_no_results_and_a_half_done_one_says_so() -> None:
    def history(record: QuizRecord) -> list[dict]:
        return build_messages(
            AskRequest(
                topic="T",
                messages=[
                    Turn(role="user", text="", mode="quiz"),
                    Turn(role="assistant", text="", quiz=record),
                    Turn(role="user", text="next"),
                ],
            )
        )

    assert [b["text"] for b in history(quiz())[-1]["content"]] == ["next"]
    half = history(quiz(picked=[1, None]))[-1]["content"][0]["text"]
    assert half.splitlines()[:3] == [
        "[Quiz results] They answered 1 of 2 questions, 1 right.",
        "1. Right.",
        "2. Not answered.",
    ]


async def test_write_quiz_uses_the_chosen_model_and_drops_broken_questions() -> None:
    written = Quiz(
        title="Derivatives",
        questions=[
            *quiz().questions,
            QuizQuestion(question="Broken", choices=["only one"], answer=0, explanation=""),
            QuizQuestion(question="No answer", choices=["a", "b"], answer=5, explanation=""),
        ],
    )
    fake = FakeIndexClient(lambda _kwargs: written)
    request = AskRequest(
        topic="Calculus", messages=[Turn(role="user", text="", context=context(), mode="quiz")]
    )
    reading = [{"type": "text", "text": "The section they are reading"}]
    result = await write_quiz(fake, request, model="claude-sonnet-5-5", reading=reading)  # type: ignore[arg-type]
    assert [q.question for q in result.questions] == [q.question for q in quiz().questions]
    sent = fake.requests[0]
    assert sent["model"] == "claude-sonnet-5-5"
    assert sent["output_format"] is Quiz
    # The section's pages come just before the request.
    *_, section, asked = sent["messages"][-1]["content"]
    assert section == reading[0]
    assert asked["text"] == f"[Quiz] {QUIZ_SECTION}"


async def test_write_quiz_fails_when_no_questions_come_back() -> None:
    fake = FakeIndexClient(lambda _kwargs: Quiz(title="Empty", questions=[]))
    request = AskRequest(topic="T", messages=[Turn(role="user", text="", mode="quiz")])
    with pytest.raises(RuntimeError):
        await write_quiz(fake, request)  # type: ignore[arg-type]


def test_quiz_endpoint_only_writes_quizzes(client: TestClient, monkeypatch) -> None:
    async def fake_write(_client, request, _usage, model, reading, **_):
        assert request.messages[-1].mode == "quiz"
        assert reading == []
        return Quiz(title=f"By {model}", questions=quiz().questions)

    main.app.dependency_overrides[main.get_client] = lambda: object()
    monkeypatch.setattr(main, "write_quiz", fake_write)
    turn = {"role": "user", "text": "", "mode": "quiz"}
    response = client.post(
        "/api/quiz", json={"topic": "T", "messages": [turn], "model": "claude-sonnet-5-5"}
    )
    assert response.status_code == 200
    assert response.json()["title"] == "By claude-sonnet-5-5"
    assert response.json()["questions"][0]["answer"] == 1
    # A document the backend doesn't have adds no section to read.
    at = {**turn, "context": {"doc_id": "missing", "doc_name": "a.pdf", "page": 3}}
    assert client.post("/api/quiz", json={"topic": "T", "messages": [at]}).status_code == 200
    plain = client.post("/api/quiz", json={"topic": "T", "messages": [{**turn, "mode": None}]})
    assert plain.status_code == 422


def test_quiz_recommendation_comes_from_haiku_only_when_something_was_wrong(
    client: TestClient,
) -> None:
    fake = FakeIndexClient(lambda _kwargs: Recommendation(text=" Read p. 12 again. "))
    main.app.dependency_overrides[main.get_client] = lambda: fake
    about = {"role": "user", "text": "the power rule", "context": {"doc_name": "a.pdf", "page": 3}}
    wrong = quiz(picked=[0, 0]).model_dump()
    response = client.post(
        "/api/quiz/recommendation", json={"topic": "T", "about": about, "quiz": wrong}
    )
    assert response.json() == {"text": "Read p. 12 again."}
    sent = fake.requests[0]
    assert sent["model"] == "claude-haiku-5-5"
    prompt = sent["messages"][0]["content"]
    assert "They are reading p. 3 of a.pdf." in prompt and "focus on: the power rule" in prompt
    assert "1. Wrong: they chose A) x" in prompt
    # Without a focus, the quiz was about the section.
    client.post(
        "/api/quiz/recommendation",
        json={"topic": "T", "about": {**about, "text": ""}, "quiz": wrong},
    )
    assert "covered the section they were reading" in fake.requests[1]["messages"][0]["content"]

    right = quiz(picked=[1, 0]).model_dump()
    response = client.post(
        "/api/quiz/recommendation", json={"topic": "T", "about": about, "quiz": right}
    )
    assert response.json() == {"text": None}
    assert len(fake.requests) == 2
