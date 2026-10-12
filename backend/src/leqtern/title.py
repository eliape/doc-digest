"""Discussion titles: Haiku names a chat from its first question, so the list of chats reads."""

import time
from typing import Any

from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field

from .usage import UsageLog, call_from_response

# A few words from one question: a cheap, quick model is enough.
TITLE_MODEL = "claude-haiku-5-5"

TITLE_PROMPT = """\
A student studying "{topic}" starts a discussion with a tutor. {about}

Write a title for the discussion: 2 to 6 words naming what it is about, in the language \
of the question, sentence case, no quotes and no full stop."""


class Title(BaseModel):
    text: str = Field(description="The title")


async def title_chat(
    client: AsyncAnthropic, topic: str, about: str, usage: UsageLog | None = None
) -> str | None:
    """A short title for a discussion that starts with `about`, or None if Haiku gave none."""
    began = time.monotonic()
    response: Any = await client.messages.parse(
        model=TITLE_MODEL,
        max_tokens=200,
        messages=[{"role": "user", "content": TITLE_PROMPT.format(topic=topic, about=about)}],
        output_format=Title,
        output_config={"effort": "low"},
    )
    if usage:
        usage.record(
            call_from_response("chat_title", TITLE_MODEL, response, time.monotonic() - began)
        )
    parsed = response.parsed_output
    title = parsed.text.strip().strip("\"'“”").rstrip(".") if parsed else ""
    return title[:80] or None
