import json

import pytest
from fastapi.testclient import TestClient

from doc_digest import main
from doc_digest.ask import AskRequest, Context, Point, Turn, build_messages, describe
from doc_digest.config import Settings, get_settings


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
    async def fake_stream(_client, request, toolbox, _usage, _model):
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
    async def failing_stream(_client, _request, _toolbox, _usage, _model):
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

    async def fake_stream(_client, _request, _toolbox, _usage, model):
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
