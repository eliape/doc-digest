import asyncio

import pytest
from fakes import FakeAnswerClient, FakeIndexClient, text
from fastapi.testclient import TestClient
from pdfs import filler, make_pdf

from leqtern import main
from leqtern.ask import SYSTEM_PROMPT, AskRequest, Turn, stream_answer
from leqtern.config import Settings
from leqtern.library import Library
from leqtern.quiz import QuizQuestion, QuizRecord
from leqtern.register import (
    MAX_NOTES,
    DiscussionRequest,
    Note,
    Register,
    Registers,
    WrittenNote,
    WrittenNotes,
    note_line,
    notes_block,
    pick,
    quiz_summary,
    unread,
    wants_notes,
    write_notes,
)
from leqtern.tools import Toolbox, TopicDoc
from leqtern.usage import UsageLog


def note(**overrides: object) -> Note:
    fields: dict[str, object] = {
        "id": "n1",
        "kind": "solved",
        "title": "July exam Q6 a)",
        "note": "Took moments about the hinge.",
        "doc_id": "exam",
        "doc_name": "exam.pdf",
        "pages": [3],
        "chat_id": "c1",
        "created": 1.0,
        "updated": 1.0,
    }
    fields.update(overrides)
    return Note.model_validate(fields)


def turn(role: str = "user", text: str = "", **overrides: object) -> Turn:
    return Turn.model_validate({"role": role, "text": text, **overrides})


def asked(*turns: Turn, chat_id: str = "c2") -> AskRequest:
    return AskRequest(topic="Mechanics", topic_id="t1", chat_id=chat_id, messages=list(turns))


def spot(page: int = 3, doc_id: str = "exam", **overrides: object) -> dict:
    return {"doc_id": doc_id, "doc_name": f"{doc_id}.pdf", "page": page, **overrides}


def test_notes_go_with_a_first_question_and_with_a_new_spot_only() -> None:
    first = asked(turn(text="How do I start b)?"))
    assert wants_notes(first)
    follow_up = asked(turn(text="b)?"), turn("assistant", "Like this."), turn(text="Why?"))
    assert not wants_notes(follow_up)
    pointed = asked(
        turn(text="b)?"),
        turn("assistant", "Like this."),
        turn(text="And this?", context=spot(point={"x": 0.5, "y": 0.5})),
    )
    assert wants_notes(pointed)
    selected = asked(
        turn(text="b)?"),
        turn("assistant", "Like this."),
        turn(text="This?", context=spot(selection="F = ma")),
    )
    assert wants_notes(selected)
    # Only the open page, without a spot, is not a new spot.
    on_page = asked(turn(text="b)?"), turn("assistant", "Ok."), turn(text="?", context=spot()))
    assert not wants_notes(on_page)


def test_a_small_register_is_sent_whole_without_the_discussion_being_had() -> None:
    register = Register(
        notes=[note(id="a", updated=2), note(id="b", chat_id="c2"), note(id="c", updated=1)]
    )
    assert [n.id for n in pick(register, turn(text="?"), "c2")] == ["c", "a"]


def test_a_large_register_sends_what_is_near_the_spot_and_shares_words_then_struggles() -> None:
    near = [note(id=f"near{p}", pages=[p], updated=p) for p in (3, 4)]
    far = [
        note(id=f"far{i}", title=f"Exercise {i}", note="Unrelated.", pages=[40 + i], updated=10 + i)
        for i in range(10)
    ]
    worded = note(
        id="worded", doc_id="book", title="Bernoulli's equation", note="Pressure terms.", pages=[90]
    )
    struggle = note(
        id="struggle", kind="struggled", title="Units", note="Mixed up kPa.", pages=[70], updated=5
    )
    other_doc = note(id="other", doc_id="book", pages=[3], title="Torque", note="Fine.")
    register = Register(notes=[*near, *far, worded, struggle, other_doc])
    question = turn(
        text="How does Bernoulli apply here?", context=spot(page=3, point={"x": 0, "y": 0})
    )
    picked = [n.id for n in pick(register, question, None)]
    assert len(picked) <= MAX_NOTES
    assert {"near3", "near4", "worded", "struggle"} <= set(picked)
    # Same page number in another document doesn't count as near.
    assert "other" not in picked
    assert not any(p.startswith("far") for p in picked)


def test_notes_read_as_one_line_each() -> None:
    line = note_line(
        note(kind="struggled", pages=[41, 42], doc_name="book.pdf", title="Gauge pressure")
    )
    assert (
        line
        == "- Struggled with: Gauge pressure (book.pdf, pp. 41–42): Took moments about the hinge."
    )
    block = notes_block([note()])
    assert block is not None
    assert block["text"].startswith("Notes on their earlier discussions in this topic:\n- Solved:")
    assert notes_block([]) is None


def discussion(*turns: tuple[str, Turn], chat_id: str = "c1", **rest: object) -> DiscussionRequest:
    messages = [{"key": key, **t.model_dump()} for key, t in turns]
    return DiscussionRequest.model_validate(
        {"topic": "Mechanics", "chat_id": chat_id, "messages": messages, **rest}
    )


def test_only_turns_not_read_yet_are_read_up_to_the_latest_answer() -> None:
    request = discussion(
        ("q1", turn(text="Q6 a)?")),
        ("a1", turn("assistant", "Moments.")),
        ("q2", turn(text="And b)?")),
        ("a2", turn("assistant", "Same idea.")),
        ("q3", turn(text="Still answering")),
    )
    register = Register(seen={"c1": ["q1", "a1"]})
    turns, keys = unread(request, register)
    assert [t.text for t in turns] == ["And b)?", "Same idea."]
    assert keys == ["q1", "a1", "q2", "a2"]
    # Nothing new once all of it is read; a question without its answer yet waits.
    assert unread(request, Register(seen={"c1": keys})) == ([], [])
    # A failed answer (no text) is not worth a call either.
    failed = discussion(("q1", turn(text="?")), ("a1", turn("assistant", "")))
    assert unread(failed, Register()) == ([], [])


def quiz_record(picked: list[int | None]) -> QuizRecord:
    question = QuizQuestion(question="Which?", choices=["x", "y"], answer=1, explanation="Because.")
    return QuizRecord(title="Pressure", questions=[question, question], picked=picked)


def test_a_quiz_answered_since_is_read_again_with_its_request() -> None:
    before = discussion(
        ("q1", turn(text="", mode="quiz")),
        ("a1/0", turn("assistant", "", quiz=quiz_record([None, None]))),
    )
    _, keys = unread(before, Register())
    after = discussion(
        ("q1", turn(text="", mode="quiz")),
        ("a1/2", turn("assistant", "", quiz=quiz_record([0, 1]))),
    )
    turns, _ = unread(after, Register(seen={"c1": keys}))
    assert [t.role for t in turns] == ["user", "assistant"]
    summary = quiz_summary(after.messages[1].quiz)  # type: ignore[arg-type]
    assert summary.splitlines() == [
        '[Quiz] "Pressure": 1 of 2 right',
        "- Wrong: Which? They chose A) x; the answer is B) y.",
    ]


async def test_haiku_adds_new_notes_and_rewrites_the_ones_it_updates(tmp_path) -> None:
    written = WrittenNotes(
        notes=[
            WrittenNote(
                id="n1",
                kind="solved",
                title="July exam Q6 a)",
                note="Solved it.",
                doc="EXAM.pdf",
                pages=[3],
            ),
            WrittenNote(
                kind="struggled", title="Sign of torque", note="Got the sign wrong.", pages=[0, 4]
            ),
            WrittenNote(kind="understood", title="  ", note="Empty titles are dropped."),
        ]
    )
    fake = FakeIndexClient(lambda _kwargs: written)
    register = Register(notes=[note(kind="worked_on", note="Started it.")])
    request = discussion(
        ("q1", turn(text="I don't get this problem", context=spot(selection="Q6 a)"))),
        ("a1", turn("assistant", "Take moments about the hinge. " + "x" * 3000 + " The end.")),
        chat_id="c9",
        title="Q6 moments",
        docs=["exam"],
    )
    usage = UsageLog(tmp_path / "u.jsonl")
    changed = await write_notes(fake, register, request, {"exam.pdf": "exam"}, usage)

    assert changed == 2
    rewritten, added = register.notes
    assert (rewritten.kind, rewritten.note, rewritten.doc_id, rewritten.chat_id) == (
        "solved",
        "Solved it.",
        "exam",
        "c9",
    )
    assert rewritten.created == 1.0 and rewritten.updated > 1.0
    assert (added.kind, added.pages, added.doc_id) == ("struggled", [4], None)
    assert register.seen == {"c9": ["q1", "a1"]}
    prompt = fake.requests[0]["messages"][0]["content"]
    assert fake.requests[0]["model"] == "claude-haiku-5-5"
    assert "[n1] worked_on: July exam Q6 a) (exam.pdf, p. 3): Started it." in prompt
    assert 'The discussion "Q6 moments"' in prompt
    assert (
        "Student: They selected this text on p. 3 of exam.pdf:\nQ6 a) I don't get this problem"
        in prompt
    )
    # Long answers are cut to their start and end.
    assert "[…]" in prompt and "The end." in prompt and "x" * 2000 not in prompt
    assert usage.summary()["register"]["calls"] == 1

    # Nothing new: no call.
    assert await write_notes(fake, register, request, {}, usage) == 0
    assert len(fake.requests) == 1


async def test_a_question_waits_for_notes_being_written(tmp_path) -> None:
    registers = Registers(tmp_path)
    lock = registers.lock("t1")
    await lock.acquire()

    async def write_then_release():
        await asyncio.sleep(0.05)
        registers.save("t1", Register(notes=[note()]))
        lock.release()

    writer = asyncio.create_task(write_then_release())
    register = await registers.settled("t1")
    await writer
    assert [n.id for n in register.notes] == ["n1"]


def test_topic_ids_that_could_name_other_files_are_refused(tmp_path) -> None:
    registers = Registers(tmp_path)
    with pytest.raises(ValueError):
        registers.path("../workspace")


async def test_notes_come_with_the_question_after_the_map_and_never_in_the_cached_parts(
    tmp_path,
) -> None:
    library = Library(tmp_path)
    info = await library.add(make_pdf([filler("torque")]), "exam.pdf")
    toolbox = Toolbox(library, [TopicDoc("D1", info, None, {"status": "queued"})])
    client = FakeAnswerClient([([text("Like in a).")], "end_turn")])
    block = notes_block([note()])
    request = asked(turn(text="b)?"))
    _ = [e async for e in stream_answer(client, request, toolbox, notes=block)]
    content = client.requests[0]["messages"][-1]["content"]
    assert content[0]["text"].startswith("The topic's documents:")
    assert content[1] == block
    assert "Notes on their earlier" not in str(client.requests[0]["system"])
    assert "Their earlier work" in SYSTEM_PROMPT


@pytest.fixture
def services(tmp_path):
    services = main.Services(Settings(data_dir=tmp_path, anthropic_api_key=None))
    main.app.dependency_overrides[main.get_services] = lambda: services
    yield services
    main.app.dependency_overrides.clear()


def test_leaving_a_discussion_notes_it_and_later_questions_get_the_notes(
    services, monkeypatch
) -> None:
    client = TestClient(main.app)
    fake = FakeIndexClient(
        lambda _kwargs: WrittenNotes(
            notes=[WrittenNote(kind="solved", title="Q6 a)", note="Used moments.", pages=[3])]
        )
    )
    main.app.dependency_overrides[main.get_client] = lambda: fake
    left = {
        "topic": "Mechanics",
        "chat_id": "c1",
        "messages": [
            {"key": "q1", "role": "user", "text": "Q6 a)?"},
            {"key": "a1", "role": "assistant", "text": "Moments."},
        ],
    }
    response = client.post("/api/topics/t1/register", json=left)
    assert response.json() == {"changed": 1, "notes": 1}
    saved = client.get("/api/topics/t1/register").json()["notes"]
    assert [(n["title"], n["chat_id"]) for n in saved] == [("Q6 a)", "c1")]

    sent: list[object] = []

    async def fake_stream(_client, _request, _toolbox, _usage, _model, notes=None):
        sent.append(notes)
        yield {"type": "done"}

    monkeypatch.setattr(main, "stream_answer", fake_stream)
    question = {"topic": "Mechanics", "topic_id": "t1", "chat_id": "c2"}
    client.post("/api/ask", json={**question, "messages": [{"role": "user", "text": "b)?"}]})
    follow_up = [
        {"role": "user", "text": "b)?"},
        {"role": "assistant", "text": "Like a)."},
        {"role": "user", "text": "Why?"},
    ]
    client.post("/api/ask", json={**question, "messages": follow_up})
    # In the discussion the note came from, it is already in the history.
    client.post(
        "/api/ask", json={**question, "chat_id": "c1", "messages": [{"role": "user", "text": "?"}]}
    )
    first, again, own = sent
    assert first is not None and "Solved: Q6 a) (p. 3): Used moments." in first["text"]  # type: ignore[index]
    assert again is None and own is None

    # Deleting the topic deletes its register.
    assert client.delete("/api/topics/t1/register").status_code == 200
    assert client.get("/api/topics/t1/register").json() == {"notes": []}
    assert client.get("/api/topics/..%2Fx/register").status_code in (404, 422)
    assert client.post("/api/topics/bad.id/register", json=left).status_code == 422
