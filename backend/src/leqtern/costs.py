"""
What the API has cost, from the usage log: per question, per quiz, for indexing, and per day.

    uv run python -m leqtern.costs                  # everything in data/usage.jsonl
    uv run python -m leqtern.costs --since 2026-10-10
    uv run python -m leqtern.costs --days 1         # the last 24 hours
"""

import argparse
import json
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from .config import get_settings
from .usage import Call, UsageLog, price_of

# A lookup round follows the previous round within this many seconds, and rereads all of it.
ROUND_GAP = 120
# How long a cache entry lives without being read.
CACHE_LIFE = 300


def short(model: str) -> str:
    """claude-sonnet-5-5 -> Sonnet 5.5"""
    parts = model.removeprefix("claude-").split("-")
    return f"{parts[0].capitalize()} {'.'.join(parts[1:])}" if len(parts) > 1 else model


def cents(dollars: float) -> str:
    if dollars >= 1:
        return f"${dollars:.2f}"
    return f"{dollars * 100:.2f}¢" if dollars < 0.001 else f"{dollars * 100:.1f}¢"


def questions(calls: list[Call]) -> list[list[Call]]:
    """
    Answer calls grouped by question. Calls log their discussion and lookup round; older
    ones are grouped by guessing: a lookup round comes right after the round before it
    and reads everything that round sent from the cache, while a new question rereads only
    the instructions and the chat history.
    """
    grouped: list[list[Call]] = []
    for c in calls:
        if c.kind != "answer":
            continue
        last = grouped[-1][-1] if grouped else None
        if c.round_no is not None:
            if c.round_no > 0 and last and last.chat_id == c.chat_id:
                grouped[-1].append(c)
            else:
                grouped.append([c])
        elif (
            last
            and last.model == c.model
            and c.at - last.at < ROUND_GAP
            and c.cache_read >= 0.9 * (last.cache_read + last.cache_write + last.input)
        ):
            grouped[-1].append(c)
        else:
            grouped.append([c])
    return grouped


def doc_names(data_dir: Path) -> dict[str, tuple[str, int]]:
    """Each stored document's name and page count, by id."""
    names: dict[str, tuple[str, int]] = {}
    for pages in (data_dir / "docs").glob("*/pages.json"):
        try:
            raw = json.loads(pages.read_text())
            names[pages.parent.name] = (raw.get("name", ""), len(raw.get("pages", [])))
        except (OSError, ValueError):
            continue
    return names


def average(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def unread_writes(answers: list[Call]) -> tuple[int, int, float]:
    """
    Of the tokens answer calls wrote to the cache, how many no later call read: in calls that
    log their discussion, a write counts as read when the discussion's next call by the same
    model starts within the cache's life and reads from the cache. Returns the tokens written,
    those never read, and the 25% extra paid for writing the unread ones.
    """
    by_chat: dict[str, list[Call]] = defaultdict(list)
    for c in answers:
        if c.chat_id:
            by_chat[c.chat_id].append(c)
    written = unread = 0
    extra = 0.0
    for mine in by_chat.values():
        for i, c in enumerate(mine):
            if not c.cache_write:
                continue
            written += c.cache_write
            later = [n for n in mine[i + 1 :] if n.answered_by == c.answered_by]
            nxt = later[0] if later else None
            if nxt and nxt.cache_read and (nxt.at - nxt.seconds) - c.at <= CACHE_LIFE:
                continue
            unread += c.cache_write
            price = price_of(c.answered_by)
            if price:
                extra += c.cache_write * price["input"] / 1e6 * 0.25
    return written, unread, extra


def report(calls: list[Call], names: dict[str, tuple[str, int]] | None = None) -> str:
    names = names or {}
    if not calls:
        return "No API calls in that period."
    lines: list[str] = []
    out = lines.append
    first = datetime.fromtimestamp(calls[0].at).strftime("%Y-%m-%d %H:%M")
    last = datetime.fromtimestamp(calls[-1].at).strftime("%Y-%m-%d %H:%M")
    out(f"{len(calls)} API calls from {first} to {last}: {cents(sum(c.cost for c in calls))}")

    out("")
    out("Questions")
    asked = questions(calls)
    if not asked:
        out("  none")
    for model in sorted({q[0].model for q in asked}):
        mine = [q for q in asked if q[0].model == model]
        costs = [sum(c.cost for c in q) for q in mine]
        lookups = [cost for q, cost in zip(mine, costs, strict=True) if len(q) > 1]
        one_round = [cost for q, cost in zip(mine, costs, strict=True) if len(q) == 1]
        out(
            f"  {short(model)}: {len(mine)} questions, {cents(average(costs))} each on average "
            f"({cents(sum(costs))} in all)"
        )
        out(f"    answered straight away: {len(one_round)}, {cents(average(one_round))} each")
        if lookups:
            out(f"    with lookups: {len(lookups)}, {cents(average(lookups))} each")
        answers = [c for q in mine for c in q]
        parts = {"new prompt": 0.0, "cache reads": 0.0, "output": 0.0}
        for c in answers:
            price = price_of(c.answered_by)
            if not price:
                continue
            per = price["input"] / 1e6
            parts["new prompt"] += c.input * per + c.cache_write * per * 1.25
            parts["cache reads"] += c.cache_read * per * 0.1
            parts["output"] += c.output * price["output"] / 1e6
        total = sum(parts.values())
        if total:
            out(
                "    where it goes: "
                + ", ".join(f"{name} {100 * v / total:.0f}%" for name, v in parts.items())
            )

    efforts = [q for q in asked if q[0].effort]
    if efforts:
        out("")
        out("Questions by effort")
        for model in sorted({q[0].model for q in efforts}):
            for effort in ("low", "medium", "high"):
                mine = [q for q in efforts if q[0].model == model and q[0].effort == effort]
                if not mine:
                    continue
                costs = [sum(c.cost for c in q) for q in mine]
                output = average([sum(c.output for c in q) for q in mine])
                out(
                    f"  {short(model)}, {effort}: {len(mine)}, {cents(average(costs))} each, "
                    f"{output:.0f} output tokens each"
                )

    answers = [c for c in calls if c.kind == "answer"]
    if answers:
        out("")
        out("Answer cache")
        for model in sorted({c.answered_by for c in answers}):
            mine = [c for c in answers if c.answered_by == model]
            hits = sum(1 for c in mine if c.cache_read)
            prompt = sum(c.input + c.cache_write + c.cache_read for c in mine)
            read = sum(c.cache_read for c in mine)
            share = 100 * read / prompt if prompt else 0
            out(
                f"  {short(model)}: {hits} of {len(mine)} calls read from the cache, "
                f"{share:.0f}% of prompt tokens"
            )
            written, unread, extra = unread_writes(mine)
            if written:
                out(
                    f"    cache writes never read: {100 * unread / written:.0f}% of "
                    f"{written} tokens written, {cents(extra)} extra paid for them"
                )

    reasons = [c for c in answers if c.stop_reason or c.stopped]
    if reasons:
        out("")
        out("Why answer calls ended")
        counts: dict[str, int] = defaultdict(int)
        for c in reasons:
            counts["stopped by the reader" if c.stopped else c.stop_reason or "?"] += 1
        for reason, n in sorted(counts.items(), key=lambda item: -item[1]):
            out(f"  {reason}: {n}")

    fell_back = [c for c in calls if c.served_model]
    if fell_back:
        out("")
        out("Fallbacks to another model")
        moves: dict[str, list[Call]] = defaultdict(list)
        for c in fell_back:
            moves[f"{short(c.model)} -> {short(c.served_model or '')}"].append(c)
        for move, mine in moves.items():
            out(f"  {move}: {len(mine)}, {cents(sum(c.cost for c in mine))}")

    for kind, title in (
        ("quiz", "Quizzes"),
        ("quiz_recommendation", "Quiz review notes"),
        ("register", "Register notes (per discussion left)"),
        ("register_tidy", "Register tidy-ups"),
    ):
        mine = [c for c in calls if c.kind == kind]
        if mine:
            out("")
            out(title)
            for model in sorted({c.model for c in mine}):
                costs = [c.cost for c in mine if c.model == model]
                out(f"  {short(model)}: {len(costs)}, {cents(average(costs))} each")

    indexing = [c for c in calls if c.kind.startswith("index")]
    if indexing:
        out("")
        out("Indexing")
        by_doc: dict[str, list[Call]] = defaultdict(list)
        for c in indexing:
            by_doc[c.doc_id or "?"].append(c)
        for doc_id, mine in by_doc.items():
            name, pages = names.get(doc_id, (doc_id, 0))
            size = f", {pages} pages" if pages else ""
            out(f"  {name}{size}: {cents(sum(c.cost for c in mine))}")

    known = {"answer", "quiz", "quiz_recommendation", "register", "register_tidy"}
    others = [c for c in calls if c.kind not in known and not c.kind.startswith("index")]
    if others:
        out("")
        out("Other calls")
        for kind in sorted({c.kind for c in others}):
            mine = [c for c in others if c.kind == kind]
            out(f"  {kind}: {len(mine)}, {cents(sum(c.cost for c in mine))}")

    out("")
    out("Per day")
    by_day: dict[str, float] = defaultdict(float)
    for c in calls:
        by_day[datetime.fromtimestamp(c.at).strftime("%Y-%m-%d")] += c.cost
    for d, total in by_day.items():
        out(f"  {d}: {cents(total)}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarise what the API has cost.")
    parser.add_argument("log", nargs="?", type=Path, help="usage log (default data/usage.jsonl)")
    parser.add_argument("--since", help="only calls from this date on, e.g. 2026-10-10")
    parser.add_argument("--days", type=float, help="only calls from the last N days")
    args = parser.parse_args()

    data_dir = get_settings().data_dir
    path = args.log or data_dir / "usage.jsonl"
    if not path.exists():
        raise SystemExit(f"No usage log at {path}. Run from the backend folder.")
    calls = sorted(UsageLog(path).calls, key=lambda c: c.at)
    if args.since:
        start = datetime.fromisoformat(args.since).timestamp()
        calls = [c for c in calls if c.at >= start]
    if args.days:
        calls = [c for c in calls if c.at >= time.time() - args.days * 86400]
    print(report(calls, doc_names(data_dir)))


if __name__ == "__main__":
    main()
