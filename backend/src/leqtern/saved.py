"""
The reader's workspace (topics, tabs, chats) saved as one JSON file, so it is
back after a reload or a restart. The frontend owns its shape; the backend
only keeps it, with a revision number so a browser tab working from an older
copy can't save over what another tab saved since.
"""

import json
import os
import threading
from pathlib import Path
from typing import Any


class SaveConflict(Exception):
    """The save was based on a copy another tab has since saved over."""


class SavedWorkspace:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def _read(self) -> dict[str, Any] | None:
        try:
            raw = json.loads(self.path.read_text())
        except FileNotFoundError:
            return None
        # Files saved before revisions are the workspace itself.
        if "workspace" not in raw:
            return {"revision": 0, "writer": None, "workspace": raw}
        return raw

    def load(self) -> dict[str, Any] | None:
        """The last saved workspace, or None before anything was saved."""
        saved = self._read()
        return saved["workspace"] if saved else None

    def revision(self) -> int:
        """How many times the workspace has been saved; 0 before the first time."""
        saved = self._read()
        return saved["revision"] if saved else 0

    def save(
        self, workspace: dict[str, Any], base: int | None = None, writer: str | None = None
    ) -> int:
        """
        Replace the saved workspace, via a temporary file so a crash can't leave half a file,
        and return its new revision. `base` is the revision the saving tab last loaded or saved,
        and `writer` names that tab. The save is refused when another tab saved since: when
        `base` is behind and the last save was not this tab's own (a tab's later saves can
        overtake each other, but they are all its own). Without `base`, it always saves.
        """
        with self._lock:
            saved = self._read()
            current = saved["revision"] if saved else 0
            last_writer = saved["writer"] if saved else None
            if base is not None and base != current and (not writer or writer != last_writer):
                raise SaveConflict
            revision = current + 1
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(
                    {"revision": revision, "writer": writer, "workspace": workspace},
                    ensure_ascii=False,
                )
            )
            os.replace(temporary, self.path)
            return revision
