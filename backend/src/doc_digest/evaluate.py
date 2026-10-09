"""
Check whether the model finds the right evidence, and what it costs.

Indexes a set of PDFs as one topic, asks questions whose answers are on known
pages, and reports for each question whether the model read and cited those
pages, plus tokens, cache use, latency and cost. Indexing cost is reported
separately for text pages and scanned pages.

    cd backend
    uv run python -m doc_digest.evaluate questions.json book.pdf scan.pdf paper.pdf

questions.json is a list of questions like this. "open" is the page the reader
is on when asking (optional); "expect" lists where the answer is.

    [
      {
        "question": "Where is the boundary condition used here derived?",
        "open": {"doc": "paper.pdf", "page": 3},
        "expect": [{"doc": "book.pdf", "pages": [41, 42]}]
      }
    ]

Indexes are kept in --data (default data/eval), so a second run only pays for
the questions. The report is printed and written to <data>/report.json.
"""

import argparse
import asyncio
import json
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic
from pydantic import BaseModel

from .ask import AskRequest, Context, Turn, stream_answer
from .config import get_settings
from .index import Indexer
from .library import DocInfo, Library
from .tools import Toolbox, topic_docs
from .usage import Call, UsageLog


class Where(BaseModel):
    doc: str
    pages: list[int]


class Open(BaseModel):
    doc: str
    page: int


class Question(BaseModel):
    question: str
    open: Open | None = None
    expect: list[Where] = []


def totals(calls: list[Call]) -> dict[str, Any]:
    prompt = sum(c.input + c.cache_write + c.cache_read for c in calls)
    return {
        "calls": len(calls),
        "input": sum(c.input for c in calls),
        "output": sum(c.output for c in calls),
        "cache_write": sum(c.cache_write for c in calls),
        "cache_read": sum(c.cache_read for c in calls),
        "cache_read_share": round(sum(c.cache_read for c in calls) / prompt, 3) if prompt else 0,
        "seconds": round(sum(c.seconds for c in calls), 2),
        "cost": round(sum(c.cost for c in calls), 5),
    }


def indexing_report(docs: list[DocInfo], usage: UsageLog) -> dict[str, Any]:
    """Cost per document, and per page for chunks of only text or only scanned pages."""
    per_doc = []
    for doc in docs:
        calls = [c for c in usage.calls if c.doc_id == doc.id and c.kind.startswith("index")]
        scanned = sum(1 for p in doc.pages if p.scanned)
        per_doc.append(
            {
                "doc": doc.name,
                "pages": doc.page_count,
                "scanned_pages": scanned,
                **totals(calls),
                "cost_per_page": round(sum(c.cost for c in calls) / doc.page_count, 6),
            }
        )
    ids = {d.id for d in docs}
    chunks = [c for c in usage.calls if c.kind == "index_chunk" and c.doc_id in ids]
    by_kind = {}
    for name, keep in (
        ("text", lambda c: c.image_pages == 0),
        ("scanned", lambda c: c.text_pages == 0),
        ("mixed", lambda c: c.text_pages and c.image_pages),
    ):
        calls = [c for c in chunks if keep(c)]
        pages = sum(c.text_pages + c.image_pages for c in calls)
        if calls:
            by_kind[name] = {
                "pages": pages,
                **totals(calls),
                "cost_per_page": round(sum(c.cost for c in calls) / pages, 6) if pages else 0,
                "seconds_per_chunk": round(sum(c.seconds for c in calls) / len(calls), 2),
            }
    return {"documents": per_doc, "chunks": by_kind}


def cited_pages(answer: str, name: str) -> set[int]:
    """Pages of a document the answer cites as (name, p. N) or (name, pp. N–M)."""
    found: set[int] = set()
    pattern = re.escape(name) + r",\s*pp?\.\s*(\d+)(?:\s*[–-]\s*(\d+))?"
    for match in re.finditer(pattern, answer):
        start = int(match.group(1))
        end = int(match.group(2) or start)
        found.update(range(start, min(end, start + 50) + 1))
    return found


async def ask_one(
    client: AsyncAnthropic,
    library: Library,
    indexer: Indexer,
    usage: UsageLog,
    topic: str,
    docs: list[DocInfo],
    q: Question,
) -> dict[str, Any]:
    by_name = {d.name: d for d in docs}
    context = None
    if q.open:
        doc = by_name[q.open.doc]
        page = doc.pages[q.open.page - 1]
        context = Context(
            doc_id=doc.id,
            doc_name=doc.name,
            page=page.page,
            page_label=page.label,
            page_texts=[{"page": page.page, "label": page.label, "text": page.text}],
        )
    request = AskRequest(
        topic=topic,
        docs=[d.id for d in docs],
        messages=[Turn(role="user", text=q.question, context=context)],
    )
    toolbox = Toolbox(library, topic_docs(library, indexer, request.docs))
    names = {d.alias: d.info.name for d in toolbox.docs.values()}
    first_call = len(usage.calls)
    answer, steps, done = "", [], {}
    async for event in stream_answer(client, request, toolbox, usage, get_settings().answer_model):
        if event["type"] == "text":
            answer += event["text"]
        elif event["type"] == "step":
            steps.append(event["text"])
        elif event["type"] == "done":
            done = event
    read = [(names[alias], page) for alias, page in toolbox.pages_read]
    expected = [(w.doc, p) for w in q.expect for p in w.pages]
    cited = {(w.doc, p) for w in q.expect for p in cited_pages(answer, w.doc)}
    return {
        "question": q.question,
        "found": bool(set(read) & set(expected)) if expected else None,
        "cited_expected": bool(cited & set(expected)) if expected else None,
        "read_expected": sorted(set(read) & set(expected)),
        "pages_read": read,
        "steps": steps,
        "answer": answer,
        "seconds": done.get("seconds"),
        "first_text_seconds": done.get("first_text_seconds"),
        "usage": totals(usage.calls[first_call:]),
    }


async def evaluate(
    pdfs: list[Path],
    questions: list[Question],
    data_dir: Path,
    answer_client: AsyncAnthropic,
    index_client: Callable[[], AsyncAnthropic | None],
    topic: str = "Evaluation",
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    library = Library(data_dir)
    usage = UsageLog(data_dir / "usage.jsonl")
    indexer = Indexer(library, usage, index_client)
    docs = [await library.add(path.read_bytes(), path.name) for path in pdfs]
    for doc in docs:
        index = indexer.get(doc.id)
        if index and index.complete:
            log(f"{doc.name}: already indexed")
            continue
        began = time.monotonic()
        log(f"{doc.name}: indexing {doc.page_count} pages…")
        await indexer.index(doc.id)
        log(f"{doc.name}: indexed in {time.monotonic() - began:.0f} s")
    results = []
    asked_from = len(usage.calls)
    for n, q in enumerate(questions, start=1):
        log(f"Question {n}/{len(questions)}: {q.question}")
        results.append(await ask_one(answer_client, library, indexer, usage, topic, docs, q))
    scored = [r for r in results if r["found"] is not None]
    return {
        "indexing": indexing_report(docs, usage),
        "questions": results,
        "summary": {
            "questions": len(results),
            "found": sum(1 for r in scored if r["found"]),
            "cited_expected": sum(1 for r in scored if r["cited_expected"]),
            "scored": len(scored),
            "answer_cost": round(sum(r["usage"]["cost"] for r in results), 4),
            "avg_seconds": round(sum(r["seconds"] or 0 for r in results) / len(results), 2)
            if results
            else 0,
            "answer_cache_read_share": totals(usage.calls[asked_from:])["cache_read_share"],
        },
    }


def print_report(report: dict[str, Any]) -> None:
    print("\nIndexing")
    for d in report["indexing"]["documents"]:
        print(
            f"  {d['doc']}: {d['pages']} pages ({d['scanned_pages']} scanned), "
            f"${d['cost']:.4f}, {d['seconds']:.0f} s of model time, "
            f"{d['input'] + d['cache_read'] + d['cache_write']} in / {d['output']} out tokens"
        )
    for kind, k in report["indexing"]["chunks"].items():
        print(
            f"  {kind} chunks: ${k['cost_per_page'] * 1000:.2f} per 1000 pages, "
            f"{k['seconds_per_chunk']} s per chunk"
        )
    print("\nQuestions")
    for r in report["questions"]:
        mark = {True: "found", False: "MISSED", None: "-"}[r["found"]]
        u = r["usage"]
        print(f"  [{mark}] {r['question']}")
        print(
            f"      read {', '.join(f'{d} p. {p}' for d, p in r['pages_read']) or 'nothing'}; "
            f"{u['calls']} calls, ${u['cost']:.4f}, {r['seconds']} s, "
            f"cache reads {u['cache_read_share']:.0%} of input"
        )
    s = report["summary"]
    print(
        f"\nFound the expected pages for {s['found']}/{s['scored']} questions "
        f"and cited them in {s['cited_expected']}. "
        f"Answers cost ${s['answer_cost']:.4f} in all, {s['avg_seconds']} s on average; "
        f"{s['answer_cache_read_share']:.0%} of answer input came from the cache."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    parser.add_argument("questions", type=Path)
    parser.add_argument("pdfs", type=Path, nargs="+")
    parser.add_argument("--data", type=Path, default=Path("data/eval"))
    parser.add_argument("--topic", default="Evaluation")
    args = parser.parse_args()
    key = get_settings().anthropic_api_key
    if not key:
        raise SystemExit("Add ANTHROPIC_API_KEY to backend/.env first.")
    client = AsyncAnthropic(api_key=key)
    questions = [Question.model_validate(q) for q in json.loads(args.questions.read_text())]
    report = asyncio.run(
        evaluate(args.pdfs, questions, args.data, client, lambda: client, args.topic)
    )
    print_report(report)
    out = args.data / "report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"\nFull report: {out}")


if __name__ == "__main__":
    main()
