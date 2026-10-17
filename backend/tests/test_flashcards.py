import io
import json
import sqlite3
import zipfile
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from fakes import text, tool_use, usage
from fastapi.testclient import TestClient

from leqtern import main
from leqtern.anki import deck_id, package, to_html
from leqtern.ask import Context, PageText, Turn
from leqtern.config import Settings
from leqtern.deck import (
    CardDraft,
    CardSource,
    Deck,
    Decks,
    can_change_type,
    delete,
    edit,
    mark_exported,
    new_card,
)
from leqtern.dedup import (
    PairVerdict,
    PairVerdicts,
    Pooled,
    Verdict,
    adjudicate,
    apply_verdict,
    guardrail,
    normalize,
    plain,
    screen,
)
from leqtern.flashcards import (
    FlashcardRequest,
    Services,
    WrittenCard,
    WrittenCards,
    closest_cards,
    drafts,
    make_flashcards,
    material,
    sync_vectors,
    transcript,
)
from leqtern.register import Register
from leqtern.tools import Toolbox


def basic(front: str, back: str, type: str = "basic") -> CardDraft:
    return CardDraft.model_validate({"type": type, "front": front, "back": back})


def unit(*values: float) -> np.ndarray:
    v = np.array(values, dtype=np.float32)
    return v / np.linalg.norm(v)


# ---- Normalising and guardrails ----


def test_latex_and_markdown_normalise_to_the_same_text() -> None:
    assert plain(r"What is $\frac{a}{b}$?") == plain("What is $a/b$?") == "what is a/b ?"
    assert plain(r"**Bold** $x^{2} \cdot y$") == "bold x^2*y"
    assert plain("x² ≤ y") == plain(r"$x^2 \le y$")


def test_cloze_cards_compare_with_basic_cards_asking_the_same() -> None:
    cloze = normalize(basic(r"The derivative of $x^2$ is {{c1::$2x$::a monomial}}", "", "cloze"))
    assert cloze.front == "the derivative of x^2 is [...] (a monomial)"
    assert cloze.back == "2x"


def test_a_negation_or_other_numbers_mean_another_question() -> None:
    not_one = normalize(basic("Which is NOT an example of negative reinforcement?", "Spanking"))
    one = normalize(basic("Which is an example of negative reinforcement?", "Spanking"))
    assert guardrail(not_one, one) == "one asks the opposite way (a negation)"
    three = normalize(basic("What is $T(n)$ for $n = 3$?", "9"))
    four = normalize(basic("What is $T(n)$ for $n = 4$?", "9"))
    assert guardrail(three, four) == "their numbers or symbols differ"
    assert guardrail(three, normalize(basic("What is $T(n)$ when $n=3$?", "9"))) is None


# ---- Stages 1 and 2 ----


def pooled(card: CardDraft, key: str = "c1", vector: np.ndarray | None = None) -> Pooled:
    return Pooled(key, card, normalize(card), vector, existing=True)


def test_near_identical_wording_is_a_duplicate_without_embeddings() -> None:
    old = basic("What does chlorophyll do in photosynthesis?", "It absorbs light")
    new = basic("What does chlorophyll do in photosynthesis ?", "It absorbs light.")
    screening = screen([new], [pooled(old)], None)
    verdict = screening.verdicts[0]
    assert (verdict.status, verdict.stage, verdict.match.key) == ("duplicate", "lexical", "c1")
    assert not screening.embeddings


def test_similar_wording_with_a_negation_goes_to_haiku_instead() -> None:
    old = basic("Which is an example of negative reinforcement?", "Removing a chore")
    new = basic("Which is not an example of negative reinforcement?", "Removing a chore")
    verdict = screen([new], [pooled(old)], None).verdicts[0]
    assert verdict.status == "new" and verdict.grey and verdict.stage == "lexical"


def test_embedding_thresholds_decide_duplicate_grey_and_new() -> None:
    deck = [pooled(basic("What is entropy?", "A measure of disorder"), vector=unit(1, 0, 0))]
    cards = [
        basic("Define entropy.", "Disorder"),
        basic("How is entropy related to heat?", "dS = dQ/T"),
        basic("What is enthalpy?", "H = U + pV"),
    ]
    forward = np.stack([unit(1, 0.2, 0), unit(1, 0.75, 0), unit(0, 1, 0)])
    flipped = np.stack([unit(0, 0, 1), unit(0, 0, 1), unit(0, 0, 1)])
    verdicts = screen(cards, deck, (forward, flipped)).verdicts
    assert [(v.status, v.grey) for v in verdicts] == [
        ("duplicate", False),
        ("new", True),
        ("new", False),
    ]
    assert verdicts[0].stage == "embedding" and verdicts[0].score > 0.88


def test_the_reverse_of_a_one_way_card_is_found_by_its_flipped_embedding() -> None:
    deck = [pooled(basic("What is the unit of force?", "The newton"), vector=unit(1, 0))]
    card = basic("The newton is the unit of what?", "Force")
    forward, flipped = np.stack([unit(0, 1)]), np.stack([unit(1, 0.1)])
    verdict = screen([card], deck, (forward, flipped)).verdicts[0]
    assert (verdict.status, verdict.flipped) == ("reverse", True)


def test_the_same_words_the_other_way_round_go_to_haiku_not_out() -> None:
    old = basic("What is the unit of force?", "The newton")
    new = basic("The newton is the unit of what?", "Force")
    verdict = screen([new], [pooled(old)], None).verdicts[0]
    assert (verdict.status, verdict.grey) == ("new", True)
    assert verdict.reason == "the questions are worded differently"


def test_later_cards_of_a_batch_are_checked_against_earlier_ones() -> None:
    first = basic("What is Ohm's law?", "V = IR")
    again = basic("What is Ohm's law ?", "V = IR")
    verdicts = screen([first, again], [], None).verdicts
    assert [v.status for v in verdicts] == ["new", "duplicate"]
    assert verdicts[1].match.key == "new:0" and not verdicts[1].match.existing


# ---- Stage 3 ----


class FakeHaiku:
    def __init__(self, verdicts: list[PairVerdict]) -> None:
        self.verdicts = verdicts
        self.requests: list[dict[str, Any]] = []
        self.messages = SimpleNamespace(parse=self._parse)

    async def _parse(self, **kwargs):
        self.requests.append(kwargs)
        return SimpleNamespace(
            parsed_output=PairVerdicts(verdicts=self.verdicts),
            usage=usage(),
            stop_reason="end_turn",
        )


async def test_haiku_judges_all_grey_pairs_in_one_call() -> None:
    fake = FakeHaiku(
        [
            PairVerdict(pair=0, verdict="DUPLICATE", reason="Same fact."),
            PairVerdict(pair=1, verdict="REVERSE_UPGRADE", reason="Other way round."),
        ]
    )
    pairs = [(basic("A?", "a"), basic("A ?", "a")), (basic("b?", "B"), basic("B?", "b"))]
    said = await adjudicate(fake, pairs)  # type: ignore[arg-type]
    assert len(fake.requests) == 1
    assert "Pair 0" in fake.requests[0]["messages"][0]["content"]
    assert [said[0].verdict, said[1].verdict] == ["DUPLICATE", "REVERSE_UPGRADE"]


@pytest.mark.parametrize(
    ("said", "match_type", "status"),
    [
        ("DUPLICATE", "basic", "duplicate"),
        ("REVERSE_UPGRADE", "basic", "reverse"),
        ("REVERSE_UPGRADE", "basic_reversed", "duplicate"),
        ("REVERSE_UPGRADE", "cloze", "new"),
        ("DISTINCT", "basic", "new"),
    ],
)
def test_haiku_verdicts_settle_grey_cards(said: str, match_type: str, status: str) -> None:
    match = pooled(basic("Q", "A", match_type))
    verdict = Verdict(match=match, grey=True)
    apply_verdict(verdict, PairVerdict(pair=0, verdict=said, reason="r"))  # type: ignore[arg-type]
    assert (verdict.status, verdict.stage, verdict.grey) == (status, "haiku", False)


def test_a_grey_card_haiku_could_not_check_is_kept_and_marked() -> None:
    verdict = Verdict(match=pooled(basic("Q", "A")), grey=True)
    apply_verdict(verdict, None)
    assert (verdict.status, verdict.unchecked) == ("new", True)


# ---- The deck ----


def test_cards_keep_their_anki_guid_and_type_changes_follow_the_note_type() -> None:
    card = new_card(basic("Q", "A"))
    guid = card.anki_guid
    deck = Deck(cards=[card])
    edit(deck, card.id, basic("Q2", "A2", "cloze"))
    assert card.anki_guid == guid and card.type == "cloze"
    edit(deck, card.id, basic("Q", "A"))
    mark_exported(deck, now=card.updated_at + 1)
    assert can_change_type(card, "basic_reversed")
    assert not can_change_type(card, "cloze")
    with pytest.raises(ValueError):
        edit(deck, card.id, basic("Q", "A", "type_answer"))


def test_changes_since_export_count_new_edited_and_deleted_cards() -> None:
    a, b, c = (new_card(basic(q, "x"), now=1.0) for q in "abc")
    deck = Deck(cards=[a, b, c])
    mark_exported(deck, now=2.0)
    edit(deck, a.id, basic("a2", "x"), now=3.0)
    delete(deck, b.id, now=3.0)
    deck.cards.append(new_card(basic("d", "x")))
    fresh = new_card(basic("e", "x"))
    deck.cards.append(fresh)
    delete(deck, fresh.id)  # never exported: nothing to delete in Anki
    assert deck.changes() == {"new": 1, "edited": 1, "deleted": 1}
    assert [d.front for d in deck.deleted] == ["b"]


class FakeEmbedder:
    """Embeds by looking texts up, else by a stable pseudo-random vector."""

    name = "fake"

    def __init__(self, known: dict[str, np.ndarray] | None = None, dim: int = 8) -> None:
        self.known = known or {}
        self.dim = dim
        self.calls: list[list[str]] = []

    def available(self) -> bool:
        return True

    def ready(self) -> bool:
        return True

    def embed(self, texts: list[str]) -> np.ndarray:
        self.calls.append(texts)
        rows = []
        for t in texts:
            if t in self.known:
                rows.append(self.known[t])
            else:
                seed = sum(ord(ch) * (i + 1) for i, ch in enumerate(t)) % (2**32)
                rows.append(unit(*np.random.default_rng(seed).normal(size=self.dim)))
        return np.stack(rows).astype(np.float32) if rows else np.zeros((0, self.dim), np.float32)


def test_the_deck_s_vectors_are_cached_and_redone_only_for_changed_cards(tmp_path) -> None:
    decks = Decks(tmp_path)
    deck = Deck(cards=[new_card(basic("What is entropy?", "Disorder")), new_card(basic("b", "c"))])
    embedder = FakeEmbedder()
    first = sync_vectors(decks, "t1", deck, embedder)
    assert len(first) == 2 and len(embedder.calls[-1]) == 2
    sync_vectors(decks, "t1", deck, embedder)
    assert len(embedder.calls) == 1
    edit(deck, deck.cards[0].id, basic("What is enthalpy?", "Heat content"))
    again = sync_vectors(decks, "t1", deck, embedder)
    assert len(embedder.calls) == 2 and len(embedder.calls[-1]) == 1
    assert set(again) == {c.id for c in deck.cards}


def test_decks_save_and_load_and_an_unreadable_one_is_kept_aside(tmp_path) -> None:
    decks = Decks(tmp_path)
    deck = Deck(cards=[new_card(basic("Q", "A"))])
    decks.save("t1", deck)
    assert decks.load("t1").cards[0].anki_guid == deck.cards[0].anki_guid
    decks.path("t1").write_text("{not json")
    assert decks.load("t1").cards == []
    assert list(tmp_path.glob("t1.unreadable-*.json"))


# ---- Anki ----


def notes_and_cards(data: bytes) -> tuple[list[tuple], list[tuple]]:
    archive = zipfile.ZipFile(io.BytesIO(data))
    path = io.BytesIO(archive.read("collection.anki2"))
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as folder:
        db = Path(folder) / "c.db"
        db.write_bytes(path.getvalue())
        con = sqlite3.connect(db)
        notes = con.execute("select id, guid, mod, flds from notes order by id").fetchall()
        cards = con.execute("select nid, ord, did from cards order by id").fetchall()
        con.close()
    return notes, cards


def test_the_package_keeps_guids_edit_times_and_makes_reverse_cards() -> None:
    one_way = new_card(basic("Term", "Definition"), now=1_700_000_000)
    two_way = new_card(basic("Symbol", "Meaning", "basic_reversed"), now=1_700_000_500)
    cloze = new_card(basic(r"$E = {{c1::mc^2}}$", "", "cloze"), now=1_700_000_900)
    notes, cards = notes_and_cards(package("t1", "Physics", Deck(cards=[one_way, two_way, cloze])))
    assert [n[1] for n in notes] == [one_way.anki_guid, two_way.anki_guid, cloze.anki_guid]
    assert [n[2] for n in notes] == [1_700_000_000, 1_700_000_500, 1_700_000_900]
    per_note = [sum(1 for c in cards if c[0] == n[0]) for n in notes]
    assert per_note == [1, 2, 1]
    assert {c[2] for c in cards} == {deck_id("t1")}
    assert notes[2][3].startswith(r"\(E = {{c1::mc^2}}\)")


def test_fields_turn_markdown_and_latex_into_anki_html() -> None:
    assert to_html(r"**Bold**, $a<b$ and $$\int_0^1 x\,dx$$ for \$5") == (
        r"<b>Bold</b>, \(a&lt;b\) and \[\int_0^1 x\,dx\] for $5"
    )
    assert to_html("Line one\nLine two") == "Line one<br>Line two"


# ---- Making cards ----


def request(**overrides: Any) -> FlashcardRequest:
    fields: dict[str, Any] = {
        "topic": "Thermodynamics",
        "topic_id": "t1",
        "count": 2,
        "types": ["basic", "cloze"],
        "context": Context(
            doc_name="book.pdf",
            page=4,
            selection="Entropy is a measure of disorder.",
            page_texts=[PageText(page=4, text="Entropy is a measure of disorder.")],
        ),
    }
    fields.update(overrides)
    return FlashcardRequest.model_validate(fields)


def test_written_cards_get_allowed_types_and_their_sources() -> None:
    toolbox = Toolbox(None, [])  # type: ignore[arg-type]
    written = [
        WrittenCard(
            type="basic_reversed", front="Entropy?", back="Disorder", extra="", doc="", pages=[]
        ),  # fmt: skip
        WrittenCard(type="cloze", front="No gap here", back="", extra="", doc="", pages=[]),
        WrittenCard(
            type="type_answer", front="Unit of S?", back="J/K", extra="", doc="", pages=[]
        ),  # fmt: skip
        WrittenCard(type="basic", front="", back="x", extra="", doc="", pages=[]),
    ]
    out = drafts(written, request(chat_id="c1"), toolbox)
    assert [(c.type, c.front) for c in out] == [("basic", "Entropy?"), ("basic", "Unit of S?")]
    assert out[0].source == CardSource(chat_id="c1")


def test_the_model_gets_the_material_the_closest_cards_and_what_to_write() -> None:
    closest = [new_card(basic("What is entropy?", "Disorder"))]
    blocks = material(request(focus="the units"), {}, closest, [])
    texts = [b["text"] for b in blocks if b["type"] == "text"]
    assert any("They selected this text on p. 4 of book.pdf" in t for t in texts)
    assert any("- (basic) Q: What is entropy? | A: Disorder" in t for t in texts)
    assert texts[-1] == "Write 3 flashcards. Allowed card types: basic, cloze.\nFocus on: the units"


def test_a_discussion_is_sent_as_a_transcript() -> None:
    turns = [
        Turn(role="user", text="Why is S a state function?"),
        Turn(role="assistant", text="Because..."),
    ]
    assert transcript(turns) == "Student: Why is S a state function?\n\nTutor: Because..."


def test_closest_cards_by_wording_without_embeddings() -> None:
    cards = [new_card(basic(f"Card {n} about {w}", "x")) for n, w in enumerate(["gas", "entropy"])]
    found = closest_cards(Deck(cards=cards), None, "entropy", None)
    assert found[0].front.endswith("entropy") or found[-1].front.endswith("entropy")


class FakeCardClient:
    """beta.messages.parse plays the scripted turns; messages.parse is Haiku's duplicate check."""

    def __init__(self, turns: list[Any], verdicts: list[PairVerdict] | None = None) -> None:
        self.turns = list(turns)
        self.requests: list[dict[str, Any]] = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(parse=self._parse))
        self.haiku = FakeHaiku(verdicts or [])
        self.messages = self.haiku.messages

    async def _parse(self, **kwargs):
        self.requests.append({**kwargs, "messages": list(kwargs["messages"])})
        return self.turns.pop(0)


def cards_turn(cards: list[WrittenCard]):
    return SimpleNamespace(
        content=[text(json.dumps({"cards": [c.model_dump() for c in cards]}))],
        stop_reason="end_turn",
        parsed_output=WrittenCards(cards=cards),
        usage=usage(),
    )


def written(front: str, back: str, type: str = "basic") -> WrittenCard:
    return WrittenCard.model_validate(
        {"type": type, "front": front, "back": back, "extra": "", "doc": "", "pages": []}
    )


async def collect(events) -> list[dict[str, Any]]:
    return [e async for e in events]


async def test_making_cards_drops_duplicates_of_the_deck_and_keeps_the_count(tmp_path) -> None:
    decks = Decks(tmp_path)
    old = new_card(basic("What is entropy?", "A measure of disorder"))
    decks.save("t1", Deck(cards=[old]))
    fake = FakeCardClient(
        [
            cards_turn(
                [
                    written("What is entropy ?", "A measure of disorder."),
                    written("What are the units of entropy?", "J/K"),
                    written("Entropy of an isolated system never {{c1::decreases}}", "", "cloze"),
                ]
            )
        ]
    )

    class NoEmbedder(FakeEmbedder):
        def available(self) -> bool:
            return False

    events = await collect(
        make_flashcards(
            fake,  # type: ignore[arg-type]
            request(),
            Toolbox(None, []),  # type: ignore[arg-type]
            Register(),
            Services(decks, NoEmbedder()),
            "claude-sonnet-5-5",
        )
    )
    result = events[-1]
    assert result["type"] == "result" and result["embeddings"] is False
    assert [c["front"] for c in result["cards"]] == [
        "What are the units of entropy?",
        "Entropy of an isolated system never {{c1::decreases}}",
    ]
    [dropped] = result["filtered"]
    assert dropped["status"] == "duplicate" and dropped["match"]["id"] == old.id
    sent = fake.requests[0]
    assert sent["model"] == "claude-sonnet-5-5"
    assert sent["output_format"] is WrittenCards
    assert "What is entropy?" in json.dumps(sent["messages"])


async def test_lookups_are_reported_and_the_reverse_of_a_deck_card_upgrades_it(tmp_path) -> None:
    decks = Decks(tmp_path)
    old = new_card(basic("What is the unit of force?", "The newton"))
    decks.save("t1", Deck(cards=[old]))
    lookup = SimpleNamespace(
        content=[tool_use("tu1", "search", {"query": "newton"})],
        stop_reason="tool_use",
        parsed_output=None,
        usage=usage(),
    )
    reverse = written("The newton is the unit of what?", "Force")
    fake = FakeCardClient([lookup, cards_turn([reverse])])
    norm_old, norm_new = (
        normalize(old),
        normalize(CardDraft(**reverse.model_dump(exclude={"doc", "pages"}))),
    )
    embedder = FakeEmbedder(
        {
            norm_old.combined: unit(1, 0),
            norm_new.combined: unit(0, 1),
            norm_new.flipped: unit(1, 0.05),
        },
        dim=2,
    )

    class Searching(Toolbox):
        async def run(self, name, raw):
            return "Found: p. 3"

        def describe(self, name, raw):
            return "Searched for “newton”"

    events = await collect(
        make_flashcards(
            fake,  # type: ignore[arg-type]
            request(),
            Searching(None, []),  # type: ignore[arg-type]
            Register(),
            Services(decks, embedder),
            "claude-opus-5-5",
        )
    )
    steps = [e["text"] for e in events if e["type"] == "step"]
    assert steps == ["Searched for “newton”", "Checking for duplicates"]
    result = events[-1]
    assert result["cards"] == []
    [dropped] = result["filtered"]
    assert (dropped["status"], dropped["upgrade"], dropped["match"]["id"]) == (
        "reverse",
        True,
        old.id,
    )
    # The lookup's result went back to the model.
    assert fake.requests[1]["messages"][-1]["content"][0]["content"] == "Found: p. 3"


# ---- The endpoints ----


@pytest.fixture
def services(tmp_path):
    services = main.Services(Settings(data_dir=tmp_path, anthropic_api_key=None, embeddings=False))
    main.app.dependency_overrides[main.get_services] = lambda: services
    yield services
    main.app.dependency_overrides.clear()


def test_cards_are_added_edited_deleted_and_exported(services) -> None:
    client = TestClient(main.app)
    old = new_card(basic("What is the unit of force?", "The newton"))
    services.decks.save("t1", Deck(cards=[old]))
    added = client.post(
        "/api/topics/t1/deck/cards",
        json={"cards": [{"type": "basic", "front": "Q", "back": "A"}], "upgrades": [old.id]},
    ).json()
    assert len(added["added"]) == 1 and len(added["cards"]) == 2
    assert added["cards"][0]["type"] == "basic_reversed"
    new_id = added["added"][0]

    exported = client.post("/api/topics/t1/deck/export", json={"name": "Mechanics"})
    assert exported.status_code == 200
    assert 'filename="Leqtern - Mechanics.apkg"' in exported.headers["content-disposition"]
    assert zipfile.ZipFile(io.BytesIO(exported.content)).namelist()
    assert client.get("/api/topics/t1/deck").json()["changes"] == {
        "new": 0,
        "edited": 0,
        "deleted": 0,
    }

    refused = client.patch(
        f"/api/topics/t1/deck/cards/{new_id}",
        json={"type": "cloze", "front": "{{c1::Q}}", "back": ""},
    )
    assert refused.status_code == 422
    edited = client.patch(
        f"/api/topics/t1/deck/cards/{new_id}", json={"type": "basic", "front": "Q2", "back": "A"}
    ).json()
    assert edited["card"]["front"] == "Q2" and edited["changes"]["edited"] == 1
    deck = client.delete(f"/api/topics/t1/deck/cards/{old.id}").json()
    assert deck["changes"]["deleted"] == 1 and len(deck["cards"]) == 1

    assert client.delete("/api/topics/t1/deck").json() == {"status": "deleted"}
    assert client.get("/api/topics/t1/deck").json()["cards"] == []


def test_making_cards_streams_its_result(services, monkeypatch) -> None:
    client = TestClient(main.app)
    main.app.dependency_overrides[main.get_client] = lambda: object()

    async def fake_make(_client, request, _toolbox, _register, _services, model):
        yield {"type": "step", "text": "Checking for duplicates"}
        yield {"type": "result", "cards": [], "filtered": [], "embeddings": False, "model": model}

    monkeypatch.setattr(main, "make_flashcards", fake_make)
    body = request().model_dump()
    response = client.post("/api/topics/t1/flashcards", json=body)
    lines = [json.loads(line) for line in response.text.splitlines()]
    assert [e["type"] for e in lines] == ["step", "result"]
    assert lines[-1]["model"] == "claude-opus-5-5"
    wrong = client.post("/api/topics/t2/flashcards", json=body)
    assert wrong.status_code == 422
