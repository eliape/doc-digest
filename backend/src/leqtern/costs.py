"""
What the API has cost, from the usage log: per question, per quiz, for indexing, and per day.

    uv run python -m leqtern.costs                  # everything in data/usage.jsonl
    uv run python -m leqtern.costs --since 2026-10-10
    uv run python -m leqtern.costs --days 1         # the last 24 hours
    uv run python -m leqtern.costs --by effort      # questions split by effort, mode,
                                                    # attached, lookups or history length
"""

import argparse
import json
import statistics
import time
from collections import defaultdict
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from .config import get_settings
from .usage import PRICES, WRITE_1H, WRITE_5M, Call, UsageLog

# A lookup round follows the previous round within this many seconds, and rereads all of it.
ROUND_GAP = 120
# How long a cache entry lives without being read: the 5-minute cache, and the 1-hour one.
CACHE_LIFE = 300
LONG_CACHE_LIFE = 3600


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
    Answer calls grouped by question: a lookup round comes right after the round before it
    and reads everything that round sent from the cache, while a new question rereads only
    the instructions and the chat history. Calls logged with a question id are grouped by it.
    """
    grouped: list[list[Call]] = []
    by_id: dict[str, list[Call]] = {}
    for c in calls:
        if c.kind != "answer":
            continue
        if c.question:
            if c.question in by_id:
                by_id[c.question].append(c)
            else:
                by_id[c.question] = [c]
                grouped.append(by_id[c.question])
            continue
        last = grouped[-1][-1] if grouped and not grouped[-1][-1].question else None
        if (
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


def history_size(turns: int | None) -> str:
    """A question's place in its chat, by the turns sent with it."""
    if turns is None:
        return "unknown"
    if turns <= 1:
        return "first question"
    for limit in (5, 15, 40):
        if turns <= limit:
            return f"up to {limit} turns"
    return "over 40 turns"


# What --by splits questions by: each question's group, from its first call.
GROUPS: dict[str, Callable[[list[Call]], str]] = {
    "effort": lambda q: q[0].effort or "unknown",
    "mode": lambda q: q[0].mode or "unknown",
    "attached": lambda q: q[0].attached or "unknown",
    "lookups": lambda q: "with lookups" if len(q) > 1 else "answered straight away",
    "history": lambda q: history_size(q[0].turns),
}


def split(asked: list[list[Call]], by: str) -> list[str]:
    """Questions per model split into groups: how many, and what they cost on average."""
    lines = [f"Questions by {by}"]
    for model in sorted({q[0].model for q in asked}):
        lines.append(f"  {short(model)}")
        groups: dict[str, list[float]] = defaultdict(list)
        for q in asked:
            if q[0].model == model:
                groups[GROUPS[by](q)].append(sum(c.cost for c in q))
        for name, costs in sorted(groups.items()):
            each, total = cents(average(costs)), cents(sum(costs))
            lines.append(f"    {name}: {len(costs)}, {each} each ({total} in all)")
    return lines


def unused_writes(calls: list[Call]) -> tuple[int, int]:
    """
    Tokens written to the 5-minute and to the 1-hour cache that no later call of the same model
    read before they expired, as far as the log shows (a read of fewer tokens than were written
    counts as a full read).
    """
    short_unused = long_unused = 0
    for i, c in enumerate(calls):
        if not c.cache_write:
            continue
        life = LONG_CACHE_LIFE if c.cache_write_1h else CACHE_LIFE
        read = False
        for later in calls[i + 1 :]:
            if later.at - c.at > life:
                break
            if later.model == c.model and later.cache_read:
                read = True
                break
        if not read:
            short_unused += c.cache_write - c.cache_write_1h
            long_unused += c.cache_write_1h
    return short_unused, long_unused


def pause(seconds: float | None) -> str:
    """How long before a question the chat's previous one was asked."""
    if seconds is None:
        return "first in the chat"
    if seconds < CACHE_LIFE:
        return "under 5 min"
    if seconds < LONG_CACHE_LIFE:
        return "5 to 60 min"
    return "over an hour"


def pauses(asked: list[list[Call]]) -> list[str]:
    """
    How the cache does after pauses of different lengths, for questions logged with their chat:
    within 5 minutes the 5-minute cache still holds the history, within an hour only the
    1-hour one does.
    """
    lines: list[str] = []
    last_in_chat: dict[str, float] = {}
    groups: dict[tuple[str, str], list[Call]] = defaultdict(list)
    for q in asked:
        first = q[0]
        if not first.chat_id:
            continue
        before = last_in_chat.get(first.chat_id)
        groups[(first.model, pause(None if before is None else first.at - before))].append(first)
        last_in_chat[first.chat_id] = first.at
    if not groups:
        return lines
    lines.append("  questions by the pause before them (first round only):")
    order = ["first in the chat", "under 5 min", "5 to 60 min", "over an hour"]
    for model, name in sorted(groups, key=lambda k: (k[0], order.index(k[1]))):
        mine = groups[(model, name)]
        hits = sum(1 for c in mine if c.cache_read)
        written = average([c.cache_write for c in mine])
        read = average([c.cache_read for c in mine])
        lines.append(
            f"    {short(model)}, {name}: {len(mine)}, {hits} read from the cache; "
            f"{written:,.0f} tokens written and {read:,.0f} read on average"
        )
    return lines


def parts(asked: list[list[Call]]) -> list[str]:
    """What the newest question is made of, in estimated tokens, for questions that log it."""
    lines: list[str] = []
    for model in sorted({q[0].model for q in asked}):
        logged = [q[0].parts for q in asked if q[0].model == model and q[0].parts]
        if not logged:
            continue
        names = sorted({name for p in logged for name in p})
        sizes = ", ".join(
            f"{name} {average([p.get(name, 0) for p in logged]):,.0f}" for name in names
        )
        lines.append(f"  {short(model)}, over {len(logged)} questions: {sizes}")
    return ["The newest question, estimated tokens on average", *lines] if lines else []


def caching(calls: list[Call]) -> list[str]:
    """How well answers use the cache, per model."""
    answers = [c for c in calls if c.kind == "answer"]
    lines = ["Cache on answers"]
    for model in sorted({c.model for c in answers}):
        mine = [c for c in answers if c.model == model]
        hits = sum(1 for c in mine if c.cache_read)
        written = sum(c.cache_write for c in mine)
        short_unused, long_unused = unused_writes(mine)
        # Unread tokens had to be sent anyway; what is lost is the write price above input.
        per = PRICES.get(model, {"input": 0.0})["input"] / 1e6
        lost = short_unused * per * (WRITE_5M - 1) + long_unused * per * (WRITE_1H - 1)
        lines.append(
            f"  {short(model)}: {hits} of {len(mine)} calls read from the cache; "
            f"{short_unused + long_unused:,} of {written:,} tokens written were never read "
            f"({cents(lost)} paid for writing them)"
        )
    lines.extend(pauses(questions(calls)))
    return lines


def report(
    calls: list[Call], names: dict[str, tuple[str, int]] | None = None, by: str | None = None
) -> str:
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
        price = PRICES.get(model)
        if price:
            per = price["input"] / 1e6
            shares = {
                "new prompt": sum(
                    c.input * per
                    + (c.cache_write - c.cache_write_1h) * per * WRITE_5M
                    + c.cache_write_1h * per * WRITE_1H
                    for c in answers
                ),
                "cache reads": sum(c.cache_read * price["cache_read"] / 1e6 for c in answers),
                "output": sum(c.output * price["output"] / 1e6 for c in answers),
            }
            total = sum(shares.values()) or 1
            out(
                "    where it goes: "
                + ", ".join(f"{name} {100 * v / total:.0f}%" for name, v in shares.items())
            )

    if by and asked:
        out("")
        lines.extend(split(asked, by))

    made_of = parts(asked)
    if made_of:
        out("")
        lines.extend(made_of)

    if asked:
        out("")
        lines.extend(caching(calls))
        waits = [c.first_text for c in calls if c.kind == "answer" and c.first_text is not None]
        if waits:
            out(
                f"  time to the first text: {statistics.median(waits):.1f} s median "
                f"over {len(waits)} answers"
            )

    logged = [c for c in calls if c.stop_reason]
    unusual = [c for c in logged if c.stop_reason not in ("end_turn", "tool_use")]
    fallbacks = [c for c in calls if c.served_model]
    if unusual or fallbacks:
        out("")
        out("Unusual calls")
        for reason in sorted({c.stop_reason or "" for c in unusual}):
            out(f"  stopped by {reason}: {sum(1 for c in unusual if c.stop_reason == reason)}")
        pairs = sorted({(c.model, c.served_model or "") for c in fallbacks})
        for asked_for, served in pairs:
            mine = [c for c in fallbacks if (c.model, c.served_model) == (asked_for, served)]
            out(
                f"  {short(asked_for)} fell back to {short(served)}: {len(mine)}, "
                f"{cents(sum(c.cost for c in mine))} in all"
            )

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
    parser.add_argument("--by", choices=sorted(GROUPS), help="split questions into groups")
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
    print(report(calls, doc_names(data_dir), args.by))


if __name__ == "__main__":
    main()
