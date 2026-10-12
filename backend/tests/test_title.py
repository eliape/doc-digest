import pytest
from fakes import FakeIndexClient
from fastapi.testclient import TestClient

from leqtern import main
from leqtern.title import Title


@pytest.fixture
def client():
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def test_a_discussion_is_named_by_haiku_from_its_first_question(client: TestClient) -> None:
    fake = FakeIndexClient(lambda _kwargs: Title(text=' "Chain rule for composites." '))
    main.app.dependency_overrides[main.get_client] = lambda: fake
    about = {
        "role": "user",
        "text": "Why does the chain rule work?",
        "context": {"doc_name": "a.pdf", "page": 3},
    }
    response = client.post("/api/chat-title", json={"topic": "Calculus", "about": about})
    assert response.json() == {"text": "Chain rule for composites"}
    sent = fake.requests[0]
    assert sent["model"] == "claude-haiku-5-5"
    prompt = sent["messages"][0]["content"]
    assert (
        '"Calculus"' in prompt
        and "p. 3 of a.pdf" in prompt
        and "They ask: Why does the chain rule work?" in prompt
    )

    # A quiz with nothing to focus on is named from where they were.
    quiz = {**about, "text": "", "mode": "quiz"}
    client.post("/api/chat-title", json={"topic": "Calculus", "about": quiz})
    assert "They asked for a quiz." in fake.requests[1]["messages"][0]["content"]


def test_an_empty_title_comes_back_as_none(client: TestClient) -> None:
    fake = FakeIndexClient(lambda _kwargs: Title(text="  "))
    main.app.dependency_overrides[main.get_client] = lambda: fake
    response = client.post(
        "/api/chat-title", json={"topic": "T", "about": {"role": "user", "text": "hi"}}
    )
    assert response.json() == {"text": None}
