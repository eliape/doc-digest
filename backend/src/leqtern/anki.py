"""
A topic's deck as an Anki package (.apkg), built with genanki.

Anki matches imported notes by GUID, so importing this file again after changes adds the new
cards and updates the edited ones in place, keeping their reviews; cards it has that the file
leaves out stay as they are. With Anki's default "Update notes: if newer", a note is only
updated when it changed here after it last changed in Anki, so each note is written with the
time its card was last edited here rather than the time of the export.

The note types have fixed ids and are Leqtern's own, so Anki's built-in ones are never touched.
Basic and Basic and reversed share one note type whose reverse card is made only when its
Reverse field is filled, so a card can be turned into Basic and reversed after it is in Anki.
"""

import hashlib
import html
import re
import tempfile
from pathlib import Path

import genanki

from .deck import Card, Deck
from .register import pages_text

CSS = """\
.card { font-family: -apple-system, system-ui, sans-serif; font-size: 20px; line-height: 1.45;
  text-align: center; color: #1f2328; background: #fff; }
.nightMode .card, .card.nightMode { color: #e6e6e6; background: #1e1e1e; }
.extra { margin-top: 1em; font-size: 0.85em; color: #57606a; }
.source { margin-top: 1.25em; font-size: 0.7em; color: #8c959f; }
.cloze { font-weight: bold; color: #0969da; }
code { font-size: 0.9em; }
"""

AFTER = (
    "{{#Extra}}<div class=extra>{{Extra}}</div>{{/Extra}}"
    "{{#Source}}<div class=source>{{Source}}</div>{{/Source}}"
)

BASIC_MODEL = genanki.Model(
    1739571201,
    "Leqtern Basic",
    fields=[
        {"name": "Front"},
        {"name": "Back"},
        {"name": "Source"},
        {"name": "Extra"},
        {"name": "Reverse"},
    ],  # fmt: skip
    templates=[
        {
            "name": "Card 1",
            "qfmt": "{{Front}}",
            "afmt": "{{FrontSide}}<hr id=answer>{{Back}}" + AFTER,
        },
        {
            # Only made when Reverse is filled in: for Basic and reversed cards.
            "name": "Card 2 (reverse)",
            "qfmt": "{{#Reverse}}{{Back}}{{/Reverse}}",
            "afmt": "{{FrontSide}}<hr id=answer>{{Front}}" + AFTER,
        },
    ],
    css=CSS,
)

TYPE_ANSWER_MODEL = genanki.Model(
    1739571202,
    "Leqtern Type Answer",
    fields=[{"name": "Front"}, {"name": "Back"}, {"name": "Source"}, {"name": "Extra"}],
    templates=[
        {
            "name": "Card 1",
            "qfmt": "{{Front}}<br><br>{{type:Back}}",
            "afmt": "{{Front}}<hr id=answer>{{type:Back}}" + AFTER,
        }
    ],
    css=CSS,
)

CLOZE_MODEL = genanki.Model(
    1739571203,
    "Leqtern Cloze",
    model_type=genanki.Model.CLOZE,
    fields=[{"name": "Front"}, {"name": "Back"}, {"name": "Source"}, {"name": "Extra"}],
    templates=[
        {
            "name": "Cloze",
            "qfmt": "{{cloze:Front}}",
            "afmt": "{{cloze:Front}}{{#Back}}<div class=extra>{{Back}}</div>{{/Back}}" + AFTER,
        }
    ],
    css=CSS,
)


class TimedNote(genanki.Note):
    """A note marked as changed when its card last was, not when the package is written."""

    def __init__(self, *args, changed: float, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.changed = changed

    def write_to_db(self, cursor, timestamp: float, deck_id, id_gen):
        super().write_to_db(cursor, self.changed, deck_id, id_gen)


def deck_id(topic_id: str) -> int:
    """A fixed Anki deck id per topic, in the range genanki recommends."""
    number = int.from_bytes(hashlib.sha1(f"leqtern-deck:{topic_id}".encode()).digest()[:8], "big")
    return (1 << 30) + number % (1 << 30)


DISPLAY_MATH = re.compile(r"\$\$(.+?)\$\$", re.S)
INLINE_MATH = re.compile(r"(?<!\\)\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)")


def inline_markdown(text: str) -> str:
    """The little Markdown cards use, as HTML: bold, italics, code and line breaks."""
    text = html.escape(text, quote=False)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*(.+?)\*\*|__(.+?)__", lambda m: f"<b>{m[1] or m[2]}</b>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<i>\1</i>", text)
    text = re.sub(r"^\s*[-*+]\s+", "• ", text, flags=re.M)
    return text.replace("\\$", "$").replace("\n", "<br>")


def to_html(text: str) -> str:
    """A side of a card as an Anki field: HTML, with maths in Anki's \\(...\\) and \\[...\\]."""
    pieces: list[str] = []
    at = 0
    pattern = re.compile(f"{DISPLAY_MATH.pattern}|{INLINE_MATH.pattern}", re.S)
    for match in pattern.finditer(text):
        pieces.append(inline_markdown(text[at : match.start()]))
        display, inline = match[1], match[2]
        tex = html.escape((display if display is not None else inline).strip(), quote=False)
        pieces.append(f"\\[{tex}\\]" if display is not None else f"\\({tex}\\)")
        at = match.end()
    pieces.append(inline_markdown(text[at:]))
    return "".join(pieces).strip()


def source_text(card: Card) -> str:
    source = card.source
    if not source or not source.doc_name:
        return ""
    pages = pages_text(source.pages)
    return html.escape(f"{source.doc_name}, {pages}" if pages else source.doc_name)


def note_for(card: Card) -> genanki.Note:
    front, back = to_html(card.front), to_html(card.back)
    source, extra = source_text(card), to_html(card.extra)
    if card.type == "cloze":
        model, fields = CLOZE_MODEL, [front, back, source, extra]
    elif card.type == "type_answer":
        # What is typed is compared with the field's text, so it stays plain.
        model, fields = TYPE_ANSWER_MODEL, [front, html.escape(card.back.strip()), source, extra]
    else:
        reverse = "y" if card.type == "basic_reversed" else ""
        model, fields = BASIC_MODEL, [front, back, source, extra, reverse]
    return TimedNote(
        model=model, fields=fields, guid=card.anki_guid, tags=["leqtern"], changed=card.updated_at
    )


def package(topic_id: str, topic_name: str, deck: Deck) -> bytes:
    """The deck as the bytes of an .apkg file, into the Anki deck "Leqtern::<topic name>"."""
    name = re.sub(r"\s*::\s*", " ", topic_name).strip() or "Topic"
    anki_deck = genanki.Deck(deck_id(topic_id), f"Leqtern::{name}")
    for card in deck.cards:
        anki_deck.add_note(note_for(card))
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "deck.apkg"
        genanki.Package(anki_deck).write_to_file(path)
        return path.read_bytes()
