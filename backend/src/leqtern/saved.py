"""
The reader's workspace (topics, tabs, chats) saved as one JSON file, so it is
back after a reload or a restart. The frontend owns its shape; the backend
only keeps it.
"""

import json
import os
import threading
from pathlib import Path
from typing import Any


class SavedWorkspace:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def load(self) -> dict[str, Any] | None:
        """The last saved workspace, or None before anything was saved."""
        try:
            return json.loads(self.path.read_text())
        except FileNotFoundError:
            return None

    def save(self, workspace: dict[str, Any]) -> None:
        """Replace the saved workspace, via a temporary file so a crash can't leave half a file."""
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(workspace, ensure_ascii=False))
            os.replace(temporary, self.path)
