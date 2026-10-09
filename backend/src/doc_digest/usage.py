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

# List prices in dollars per million tokens (Claude API, October 2026). Cache
# writes are 1.25x input (5-minute cache) and cache reads 0.1x input.
# Haiku 5.5 costs 5x more for prompts over 100K tokens; indexing stays under that.
PRICES: dict[str, dict[str, float]] = {
    "claude-opus-5-5": {"input": 4.00, "output": 20.00},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00},
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50},
}


def cost(model: str, input: int, output: int, cache_write: int, cache_read: int) -> float:
    price = PRICES.get(model)
    if not price:
        return 0.0
    per_token = price["input"] / 1e6
    return (
        input * per_token
        + cache_write * per_token * 1.25
        + cache_read * per_token * 0.1
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


def call_from_response(kind: str, model: str, response: Any, seconds: float, **extra: Any) -> Call:
    usage = response.usage
    input = usage.input_tokens or 0
    output = usage.output_tokens or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", None) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", None) or 0
    return Call(
        kind=kind,
        model=model,
        input=input,
        output=output,
        cache_write=cache_write,
        cache_read=cache_read,
        seconds=round(seconds, 3),
        cost=cost(model, input, output, cache_write, cache_read),
        request_id=getattr(response, "_request_id", None),
        **extra,
    )


class UsageLog:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.calls: list[Call] = []
        if path and path.exists():
            for line in path.read_text().splitlines():
                if line.strip():
                    self.calls.append(Call(**json.loads(line)))

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
