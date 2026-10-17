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


@pytest.fixture(autouse=True)
def separate_data(tmp_path, monkeypatch):
    """Keep tests' PDFs and usage log out of the real data folder, so they never add made-up calls
    to what `make costs` reports."""
    from leqtern import main

    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    # Never load the real embedding model in tests (it downloads on first use).
    monkeypatch.setenv("EMBEDDINGS", "false")
    main._services.cache_clear()
    yield
    main._services.cache_clear()
