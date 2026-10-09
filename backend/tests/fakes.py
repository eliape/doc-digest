"""Stand-ins for the Anthropic client that return scripted responses."""

from types import SimpleNamespace
from typing import Any


def usage(input: int = 100, output: int = 20, cache_read: int = 0, cache_write: int = 0):
    return SimpleNamespace(
        input_tokens=input,
        output_tokens=output,
        cache_read_input_tokens=cache_read,
        cache_creation_input_tokens=cache_write,
    )


def text(value: str):
    return SimpleNamespace(type="text", text=value)


def tool_use(id: str, name: str, input: dict[str, Any]):
    return SimpleNamespace(type="tool_use", id=id, name=name, input=input)


class FakeStream:
    def __init__(self, content: list, stop_reason: str) -> None:
        self.content = content
        self.stop_reason = stop_reason

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    def __aiter__(self):
        async def events():
            for block in self.content:
                if block.type == "text":
                    yield SimpleNamespace(type="text", text=block.text)

        return events()

    async def get_final_message(self):
        return SimpleNamespace(content=self.content, stop_reason=self.stop_reason, usage=usage())


class FakeAnswerClient:
    """Each call to beta.messages.stream returns the next scripted turn."""

    def __init__(self, turns: list[tuple[list, str]]) -> None:
        self.turns = list(turns)
        self.requests: list[dict[str, Any]] = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs):
        # Copy the messages: the caller keeps appending to the same list.
        self.requests.append({**kwargs, "messages": list(kwargs["messages"])})
        content, stop = self.turns.pop(0)
        return FakeStream(content, stop)


class FakeIndexClient:
    """messages.parse returns what `respond(kwargs)` gives as the parsed output."""

    def __init__(self, respond) -> None:
        self.respond = respond
        self.requests: list[dict[str, Any]] = []
        self.messages = SimpleNamespace(parse=self._parse)

    async def _parse(self, **kwargs):
        self.requests.append(kwargs)
        return SimpleNamespace(
            parsed_output=self.respond(kwargs), usage=usage(), stop_reason="end_turn"
        )
