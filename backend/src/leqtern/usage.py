"""
What each model call cost: tokens, cache use, latency and dollars, appended
to a JSON-lines log so real numbers can be compared with the estimates.
"""

import json
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# List prices in dollars per million tokens (Claude API, October 2026). Cache writes
# are 1.25x input for the 5-minute cache and 2x for the 1-hour one.
# Haiku 5.5 costs 5x more for prompts over 100K tokens; indexing stays under that.
PRICES: dict[str, dict[str, float]] = {
    "claude-opus-5-5": {"input": 4.00, "output": 20.00, "cache_read": 0.20},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.20},
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01},
}
# What writing a token to the cache costs, as a multiple of the input price.
WRITE_5M = 1.25
WRITE_1H = 2.0


def cost(
    model: str, input: int, output: int, cache_write: int, cache_read: int, cache_write_1h: int = 0
) -> float:
    """`cache_write` counts every token written to the cache, `cache_write_1h` those for an hour."""
    price = PRICES.get(model)
    if not price:
        return 0.0
    per_token = price["input"] / 1e6
    return (
        input * per_token
        + (cache_write - cache_write_1h) * per_token * WRITE_5M
        + cache_write_1h * per_token * WRITE_1H
        + cache_read * price["cache_read"] / 1e6
        + output * price["output"] / 1e6
    )


@dataclass
class Call:
    """One model call."""

    kind: str  # "index_chunk", "index_summary" or "answer"
    model: str
    input: int
    output: int
    cache_write: int
    cache_read: int
    seconds: float
    cost: float
    at: float = field(default_factory=time.time)
    doc_id: str | None = None
    text_pages: int = 0
    image_pages: int = 0
    request_id: str | None = None
    # An answer the reader stopped while it was arriving; its output count is too low.
    stopped: bool = False
    # The model that really answered, when the API fell back from `model` to another one.
    served_model: str | None = None
    stop_reason: str | None = None
    # What the question asked for, on answer and quiz calls. Older log lines have none of these.
    effort: str | None = None
    mode: str | None = None  # "normal", "socratic" or "quiz"
    attached: str | None = None  # "spot", "selection" or "none"
    turns: int | None = None  # turns in the conversation sent, the newest question included
    chat_id: str | None = None  # the discussion the question was asked in
    # Answer calls of one question share an id; round 0 is the first call, later rounds lookups.
    question: str | None = None
    round_no: int | None = None
    tools: list[str] = field(default_factory=list)  # the lookups the round asked for
    first_text: float | None = None  # seconds from the question to the answer's first text
    # Of cache_write, the tokens written to the 1-hour cache.
    cache_write_1h: int = 0
    # Estimated tokens of each part of the newest question ("image", "page text", "map", ...),
    # on the first call of a question.
    parts: dict[str, int] = field(default_factory=dict)

    def priced(self) -> float:
        """What the call costs at today's prices, as the model that answered when we know it."""
        model = self.served_model if self.served_model in PRICES else self.model
        args = (self.input, self.output, self.cache_write, self.cache_read, self.cache_write_1h)
        return cost(model, *args)


def call_from_response(kind: str, model: str, response: Any, seconds: float, **extra: Any) -> Call:
    usage = response.usage
    input = usage.input_tokens or 0
    output = usage.output_tokens or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", None) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", None) or 0
    split = getattr(usage, "cache_creation", None)
    cache_write_1h = getattr(split, "ephemeral_1h_input_tokens", None) or 0
    served = getattr(response, "model", None)
    # A dated id of the same model ("claude-opus-5-5-2026...") is not a fallback.
    served = served if isinstance(served, str) and not served.startswith(model) else None
    call = Call(
        kind=kind,
        model=model,
        input=input,
        output=output,
        cache_write=cache_write,
        cache_read=cache_read,
        cache_write_1h=cache_write_1h,
        seconds=round(seconds, 3),
        cost=0.0,
        request_id=getattr(response, "_request_id", None),
        served_model=served,
        stop_reason=getattr(response, "stop_reason", None),
        **extra,
    )
    call.cost = call.priced()
    return call


class UsageLog:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.calls: list[Call] = []
        if path and path.exists():
            for line in path.read_text().splitlines():
                if line.strip():
                    call = Call(**json.loads(line))
                    # Older lines were priced with Opus cache reads at twice their price.
                    call.cost = call.priced()
                    self.calls.append(call)

    def record(self, call: Call) -> Call:
        self.calls.append(call)
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a") as f:
                f.write(json.dumps(asdict(call)) + "\n")
        return call

    def summary(self) -> dict[str, Any]:
        """Totals per kind of call, and indexing cost split by text and scanned pages."""
        by_kind: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        for c in self.calls:
            k = by_kind[c.kind]
            k["calls"] += 1
            for name in ("input", "output", "cache_write", "cache_read", "seconds", "cost"):
                k[name] += getattr(c, name)
            k["text_pages"] += c.text_pages
            k["image_pages"] += c.image_pages
        result: dict[str, Any] = {}
        for kind, k in by_kind.items():
            prompt = k["input"] + k["cache_write"] + k["cache_read"]
            result[kind] = {
                **{name: round(v, 4) for name, v in k.items()},
                "cache_read_share": round(k["cache_read"] / prompt, 3) if prompt else 0,
                "avg_seconds": round(k["seconds"] / k["calls"], 2),
                "avg_cost": round(k["cost"] / k["calls"], 5),
            }
        return result
