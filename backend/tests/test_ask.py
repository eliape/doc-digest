import collections
import json
import random

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
    request_system,
    system_blocks,
    write_quiz,
)
from leqtern.config import Settings, get_settings
from leqtern.quiz import (
    Distractor,
    Quiz,
    QuizQuestion,
    QuizRecord,
    Recommendation,
    WrittenQuestion,
    WrittenQuiz,
    arrange,
)


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


def written_question(question: str, answer: str, *wrong: str) -> WrittenQuestion:
    return WrittenQuestion(
        level="application",
        question=question,
        answer=answer,
        distractors=[Distractor(misconception_rationale=f"Why {w}.", text=w) for w in wrong],
        explanation="Because.",
    )


async def test_write_quiz_uses_the_chosen_model_and_drops_broken_questions() -> None:
    written = WrittenQuiz(
        title="Derivatives",
        questions=[
            written_question("What is f'(x) for x^2?", "2x", "x", "x^2", "2"),
            written_question("No wrong answers", "a"),
            written_question("No right answer", " ", "b", "c"),
        ],
    )
    fake = FakeIndexClient(lambda _kwargs: written)
    request = AskRequest(
        topic="Calculus", messages=[Turn(role="user", text="", context=context(), mode="quiz")]
    )
    reading = [{"type": "text", "text": "The section they are reading"}]
    result = await write_quiz(fake, request, model="claude-sonnet-5-5", reading=reading)  # type: ignore[arg-type]
    [question] = result.questions
    assert sorted(question.choices) == ["2", "2x", "x", "x^2"]
    assert question.choices[question.answer] == "2x"
    # Each wrong choice keeps the mistake behind it; the right one has none.
    for choice, why in zip(question.choices, question.misconceptions, strict=True):
        assert why == (None if choice == "2x" else f"Why {choice}.")
    sent = fake.requests[0]
    assert sent["model"] == "claude-sonnet-5-5"
    assert sent["output_format"] is WrittenQuiz
    # The section's pages come just before the request.
    *_, section, asked = sent["messages"][-1]["content"]
    assert section == reading[0]
    assert asked["text"] == f"[Quiz] {QUIZ_SECTION}"


def test_the_right_answer_lands_evenly_among_the_choices() -> None:
    # The model writes the right answer first; over many questions it lands on each letter
    # about as often, and each wrong choice keeps the mistake behind it.
    written = WrittenQuiz(title="T", questions=[written_question("Q?", "right", "a", "b", "c")])
    rng = random.Random(0)
    places = collections.Counter()
    for _ in range(4000):
        [q] = arrange(written, rng).questions
        places[q.answer] += 1
        assert q.choices[q.answer] == "right"
        for choice, why in zip(q.choices, q.misconceptions, strict=True):
            assert why == (None if choice == "right" else f"Why {choice}.")
    assert sorted(places) == [0, 1, 2, 3]
    assert all(900 < n < 1100 for n in places.values()), places


def test_quiz_writing_rules_are_in_the_prompt() -> None:
    for rule in ["mistake", "self-contained", "parallel", "none of the above", "application"]:
        assert rule in SYSTEM_PROMPT or rule in str(WrittenQuiz.model_json_schema())


async def test_write_quiz_fails_when_no_questions_come_back() -> None:
    fake = FakeIndexClient(lambda _kwargs: WrittenQuiz(title="Empty", questions=[]))
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
    # Maths comes back as LaTeX, which the app renders.
    assert "LaTeX between dollar signs" in prompt
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


def test_without_an_attachment_the_page_is_named_not_shown() -> None:
    page = context(doc_id="abc", page_image="PAGE", page_texts=[{"page": 12, "text": "Words"}])
    request = AskRequest(topic="Calculus", messages=[Turn(role="user", text="why?", context=page)])
    content = build_messages(request, {"abc": "D1"})[0]["content"]
    assert [b["type"] for b in content] == ["text", "text", "text"]
    assert content[0]["text"] == "They are reading p. 12 of notes.pdf (D1)."
    assert 'read_pages, doc "D1"' in content[1]["text"]
    assert "Words" not in str(content)


def test_the_page_is_shown_when_the_model_cannot_look_it_up() -> None:
    # Not in the topic's documents (or a quiz, which has no tools): the page goes along.
    page = context(doc_id="abc", page_image="PAGE")
    request = AskRequest(topic="Calculus", messages=[Turn(role="user", text="why?", context=page)])
    content = build_messages(request)[0]["content"]
    assert any(b["type"] == "image" for b in content)


def test_the_readers_instructions_come_between_the_fixed_prompt_and_the_topic() -> None:
    assert len(system_blocks("T")) == 2
    assert len(system_blocks("T", "  ")) == 2
    fixed, own, topic = system_blocks("T", " Answer in Swedish. ")
    assert fixed["text"] == SYSTEM_PROMPT
    assert "<reader_instructions>\nAnswer in Swedish.\n</reader_instructions>" in own["text"]
    # One breakpoint at the end caches all three.
    assert "cache_control" not in own
    assert topic["cache_control"] == {"type": "ephemeral", "ttl": "1h"}


def test_a_topics_scope_and_conventions_go_with_its_name_in_the_cached_prompt() -> None:
    _, topic = system_blocks(
        "Mechanics", "", " Chapters 1-6, exam on 12 Dec ", "Clockwise torque is positive."
    )
    assert topic["text"].startswith('The topic is called "Mechanics".')
    assert "<topic_scope>\nChapters 1-6, exam on 12 Dec\n</topic_scope>" in topic["text"]
    assert (
        "<topic_conventions>\nClockwise torque is positive.\n</topic_conventions>" in topic["text"]
    )
    assert topic["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    # Left empty, they add nothing.
    assert system_blocks("Mechanics", "", " ", "")[-1]["text"] == 'The topic is called "Mechanics".'
    request = AskRequest(topic="Mechanics", scope="Exam", messages=[Turn(role="user", text="?")])
    assert "<topic_scope>\nExam\n</topic_scope>" in request_system(request)[-1]["text"]


def test_the_mistake_behind_a_wrong_answer_goes_into_the_history() -> None:
    record = quiz(picked=[0, 0])
    record.questions[0].misconceptions = [
        "Forgets to bring the power down.",
        None,
        "Leaves the power as it is.",
    ]
    request = AskRequest(
        topic="T",
        messages=[
            Turn(role="user", text="", mode="quiz"),
            Turn(role="assistant", text="", quiz=record),
            Turn(role="user", text="next"),
        ],
    )
    _, written, after = build_messages(request)
    assert (
        "   A) x (the mistake: Forgets to bring the power down.)" in written["content"][0]["text"]
    )
    assert "   B) 2x\n" in written["content"][0]["text"]
    results = after["content"][0]["text"]
    assert (
        "1. Wrong: they chose A) x (the mistake: Forgets to bring the power down.); "
        "the answer is B) 2x." in results
    )


def test_the_instructions_and_history_are_cached_for_an_hour() -> None:
    from leqtern.ask import system_blocks

    request = AskRequest(
        topic="T",
        messages=[
            Turn(role="user", text="one"),
            Turn(role="assistant", text="first answer"),
            Turn(role="user", text="two"),
        ],
    )
    messages = build_messages(request)
    assert messages[1]["content"][-1]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert system_blocks("T")[-1]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}


def test_the_parts_of_a_question_are_measured() -> None:
    import base64
    import io

    from PIL import Image

    from leqtern.ask import question_parts

    buffer = io.BytesIO()
    Image.new("RGB", (750, 100)).save(buffer, "JPEG")
    image = base64.b64encode(buffer.getvalue()).decode()
    topic_map = {"type": "text", "text": "m" * 35}
    content = [
        topic_map,
        {"type": "text", "text": "Around where they pointed:"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image}},
        {"type": "text", "text": "Text the PDF has on p. 3:\n" + "y" * 74},
    ]
    sizes = question_parts(content, map=[topic_map], notes=[None])
    assert sizes == {"map": 10, "question": 7, "image": 100, "page text": 29}


def test_the_text_around_a_spot_is_not_sent_twice() -> None:
    ctx = context(
        page_image="BAND",
        point={"x": 0.5, "y": 0.5},
        image_pages=[12],
        nearby_text="NEARBY",
        page_texts=[{"page": 12, "text": "band text with NEARBY in it"}],
    )
    from leqtern.ask import context_blocks

    texts = [b["text"] for b in context_blocks(ctx) if b["type"] == "text"]
    assert not any(t.endswith("NEARBY") for t in texts)
    assert any("band text" in t for t in texts)
