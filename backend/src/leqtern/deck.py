"""
Each topic's deck of flashcards, made in Leqtern and studied in Anki. The cards are kept as one
JSON file per topic, with their embeddings beside it in a NumPy archive so duplicates can be
found without embedding the whole deck again.

A card's Anki GUID is made once, when the card is, and never changes: Anki matches imported
notes by it, so re-importing the deck updates the cards it already has (keeping their reviews)
and adds the new ones.
"""

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Literal

import genanki
import numpy as np
from pydantic import BaseModel, Field, ValidationError

from .register import valid_topic_id

logger = logging.getLogger(__name__)

CardType = Literal["basic", "basic_reversed", "cloze", "type_answer"]

CARD_TYPES: tuple[CardType, ...] = ("basic", "basic_reversed", "cloze", "type_answer")

# Basic and Basic and reversed are one Anki note type (the reverse card is optional on it), so a
# card can switch between them after it was exported. Any other change of type after an export
# would give Anki a note of another type under the same GUID, which it does not import.
SAME_NOTE_TYPE = {"basic", "basic_reversed"}


class CardSource(BaseModel):
    """Where a card comes from: a PDF's pages, a discussion, or both."""

    doc_id: str | None = None
    doc_name: str | None = None
    pages: list[int] = []
    chat_id: str | None = None


class CardDraft(BaseModel):
    """A card as it is written or edited, before it is in the deck."""

    type: CardType
    front: str = Field(description="The question; for a cloze card the text with {{c1::gaps}}")
    back: str = Field(description="The answer; for a cloze card extra text shown after it")
    extra: str = ""
    source: CardSource | None = None


class Card(CardDraft):
    id: str
    anki_guid: str
    created_at: float
    updated_at: float
    last_exported_at: float | None = None

    @property
    def exported(self) -> bool:
        return self.last_exported_at is not None

    @property
    def changed_since_export(self) -> bool:
        return self.last_exported_at is not None and self.updated_at > self.last_exported_at


class DeletedCard(BaseModel):
    """A card deleted after it was exported: Anki still has it until it is deleted there too."""

    id: str
    front: str
    deleted_at: float


class Deck(BaseModel):
    version: Literal[1] = 1
    cards: list[Card] = []
    deleted: list[DeletedCard] = []
    exported_at: float | None = None

    def get(self, card_id: str) -> Card | None:
        return next((c for c in self.cards if c.id == card_id), None)

    def changes(self) -> dict[str, int]:
        """What changed since the last export: cards new to Anki, edited and deleted."""
        return {
            "new": sum(not c.exported for c in self.cards),
            "edited": sum(c.changed_since_export for c in self.cards),
            "deleted": len(self.deleted),
        }


def new_card(draft: CardDraft, now: float | None = None) -> Card:
    now = time.time() if now is None else now
    card_id = uuid.uuid4().hex[:16]
    return Card(
        **draft.model_dump(),
        id=card_id,
        # Anki's own GUID form, from the card's id; stored, so it never changes with the text.
        anki_guid=genanki.guid_for("leqtern", card_id),
        created_at=now,
        updated_at=now,
    )


def can_change_type(card: Card, to: CardType) -> bool:
    """Whether a card can become `to`: any type before its first export, then within a note type."""
    return to == card.type or not card.exported or {card.type, to} <= SAME_NOTE_TYPE


def edit(deck: Deck, card_id: str, changes: CardDraft, now: float | None = None) -> Card:
    """
    Change a card's text or type. Raises KeyError for no such card, and ValueError for a type
    it can't take.
    """
    card = deck.get(card_id)
    if card is None:
        raise KeyError(card_id)
    if not can_change_type(card, changes.type):
        raise ValueError(
            "This card is in Anki already, so it can only switch between Basic and "
            "Basic and reversed."
        )
    card.type = changes.type
    card.front = changes.front
    card.back = changes.back
    card.extra = changes.extra
    if changes.source is not None:
        card.source = changes.source
    card.updated_at = time.time() if now is None else now
    return card


def delete(deck: Deck, card_id: str, now: float | None = None) -> bool:
    """Delete a card. One Anki already has is listed, so the reader knows to delete it there too."""
    card = deck.get(card_id)
    if card is None:
        return False
    deck.cards.remove(card)
    if card.exported:
        now = time.time() if now is None else now
        deck.deleted.append(DeletedCard(id=card.id, front=card.front, deleted_at=now))
    return True


def mark_exported(deck: Deck, now: float | None = None) -> None:
    now = time.time() if now is None else now
    for card in deck.cards:
        card.last_exported_at = now
    deck.deleted = []
    deck.exported_at = now


class Decks:
    """Each topic's deck, as `<topic id>.json`, and its embeddings as `<topic id>.npz`."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._locks: dict[str, asyncio.Lock] = {}

    def path(self, topic_id: str) -> Path:
        if not valid_topic_id(topic_id):
            raise ValueError(f"Not a topic id: {topic_id!r}")
        return self.root / f"{topic_id}.json"

    def vectors_path(self, topic_id: str) -> Path:
        return self.path(topic_id).with_suffix(".npz")

    def lock(self, topic_id: str) -> asyncio.Lock:
        """Held while a topic's deck is being changed, so two changes can't overwrite each other."""
        return self._locks.setdefault(topic_id, asyncio.Lock())

    def load(self, topic_id: str) -> Deck:
        try:
            return Deck.model_validate_json(self.path(topic_id).read_text())
        except FileNotFoundError:
            return Deck()
        except (ValidationError, json.JSONDecodeError):
            # Kept aside rather than overwritten by the next save, so no cards are lost for good.
            path = self.path(topic_id)
            aside = path.with_name(f"{topic_id}.unreadable-{int(time.time())}.json")
            logger.exception("Unreadable deck for topic %s; moved to %s", topic_id, aside.name)
            os.replace(path, aside)
            return Deck()

    def save(self, topic_id: str, deck: Deck) -> None:
        """Replace the topic's deck, via a temporary file so a crash can't leave half a file."""
        path = self.path(topic_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(deck.model_dump_json(indent=1))
        os.replace(temporary, path)

    def delete(self, topic_id: str) -> None:
        self.path(topic_id).unlink(missing_ok=True)
        self.vectors_path(topic_id).unlink(missing_ok=True)
        self._locks.pop(topic_id, None)

    def load_vectors(self, topic_id: str) -> "VectorCache":
        try:
            with np.load(self.vectors_path(topic_id), allow_pickle=False) as data:
                ids, digests = list(data["card_ids"]), list(data["digests"])
                return VectorCache(ids, digests, data["vectors"].astype(np.float32))
        except (FileNotFoundError, KeyError, ValueError, OSError):
            return VectorCache()

    def save_vectors(self, topic_id: str, cache: "VectorCache") -> None:
        path = self.vectors_path(topic_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{topic_id}.tmp.npz")
        np.savez(
            temporary,
            card_ids=np.array(cache.card_ids, dtype=str),
            digests=np.array(cache.digests, dtype=str),
            vectors=cache.vectors,
        )
        os.replace(temporary, path)


def digest(text: str, model: str) -> str:
    """Names what a vector was made from, so a card's vector is redone when its text changes."""
    return hashlib.sha1(f"{model}\n{text}".encode()).hexdigest()[:16]


class VectorCache:
    """Embeddings of a deck's cards: one L2-normalised row per card id."""

    def __init__(
        self,
        card_ids: list[str] | None = None,
        digests: list[str] | None = None,
        vectors: np.ndarray | None = None,
    ) -> None:
        self.card_ids = [str(i) for i in card_ids or []]
        self.digests = [str(d) for d in digests or []]
        self.vectors = vectors if vectors is not None else np.zeros((0, 0), dtype=np.float32)

    def rows(self) -> dict[str, tuple[str, np.ndarray]]:
        pairs = zip(self.card_ids, self.digests, strict=True)
        return {i: (d, self.vectors[n]) for n, (i, d) in enumerate(pairs)}
