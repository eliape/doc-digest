import inspect
import sys
from pathlib import Path

import pytest

# Test helpers (pdfs.py, fakes.py) live next to the tests.
sys.path.insert(0, str(Path(__file__).parent))


@pytest.fixture
def anyio_backend():
    return "asyncio"


def pytest_collection_modifyitems(items):
    """Run async tests on asyncio through AnyIO's plugin, which FastAPI already brings."""
    for item in items:
        if inspect.iscoroutinefunction(getattr(item, "function", None)):
            item.add_marker(pytest.mark.anyio)
