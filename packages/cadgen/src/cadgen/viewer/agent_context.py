"""What a person has selected in the viewer, for the agent they are talking to.

A page in a browser cannot reach an agent's conversation, so the selection waits here until the
agent's own hook asks for it, when the person sends their next message (the way an editor's
selected lines go along). Off unless ``CADGEN_AGENT_CONTEXT`` is set.

Each tab of the viewer holds one selection, kept in memory and dropped with the server: it is the
state of a page, not of a project. A conversation reads a given selection once, and one conversation
reading it takes nothing from another. Only a selection in the conversation's own project is handed
to it, and every path the page served through a symlink is named by its real path.

The loopback bind, the Host allowlist and the ``x-cadgen-viewer`` header guard these routes as they
do every other (``http_app.py``).
"""

from __future__ import annotations

import os
import threading
import time

ENV = "CADGEN_AGENT_CONTEXT"
MAX_BODY_BYTES = 256 * 1024
# A selection left behind in a forgotten tab must not ride along with a message hours later.
TTL_SECONDS = 6 * 60 * 60
MAX_TABS = 16


def enabled() -> bool:
    return bool(os.environ.get(ENV))


def _inside(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


class AgentContext:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._lock = threading.Lock()
        self._slots: dict[str, dict] = {}
        self._revision = 0

    def publish(self, tab: str, text: str, paths: list[str]) -> dict:
        """Set what ``tab`` has selected; empty ``text`` clears it. The same selection again is not new."""
        real = {path: os.path.realpath(path) for path in paths}
        for served in sorted(real, key=len, reverse=True):
            text = text.replace(served, real[served])
        with self._lock:
            self._expire()
            if not text:
                self._slots.pop(tab, None)
                return {"revision": self._revision}
            held = self._slots.get(tab)
            if held and held["text"] == text:
                held["at"] = self._clock()
                return {"revision": held["revision"]}
            self._revision += 1
            self._slots[tab] = {"text": text, "paths": list(real.values()), "at": self._clock(), "revision": self._revision, "sessions": set()}
            while len(self._slots) > MAX_TABS:
                del self._slots[min(self._slots, key=lambda name: self._slots[name]["at"])]
            return {"revision": self._revision}

    def status(self, tab: str) -> dict:
        """Whether a conversation has read what ``tab`` has selected now."""
        with self._lock:
            self._expire()
            held = self._slots.get(tab)
            return {"revision": held["revision"] if held else 0, "delivered": bool(held and held["sessions"])}

    def read(self, session: str, cwd: str) -> list[dict]:
        """What this conversation has not been told yet, of the selections in its own project."""
        root = os.path.realpath(cwd)
        with self._lock:
            self._expire()
            items = []
            for held in self._slots.values():
                if session in held["sessions"] or not any(_inside(path, root) for path in held["paths"]):
                    continue
                held["sessions"].add(session)
                items.append({"text": held["text"]})
            return items

    def _expire(self) -> None:
        oldest = self._clock() - TTL_SECONDS
        for tab in [tab for tab, held in self._slots.items() if held["at"] < oldest]:
            del self._slots[tab]


def publication(payload) -> tuple[str, str, list[str]]:
    """A ``POST /__cad/context`` body, checked: the tab, its selection as text, and the paths that text names."""
    if type(payload) is not dict or set(payload) != {"tab", "text", "paths"}:
        raise ValueError("A publication has a tab, a text and its paths")
    tab, text, paths = payload["tab"], payload["text"], payload["paths"]
    if type(tab) is not str or not tab or len(tab) > 64 or type(text) is not str:
        raise ValueError("A publication's tab and text are strings")
    if type(paths) is not list or not all(type(path) is str and os.path.isabs(path) for path in paths):
        raise ValueError("A publication's paths are absolute")
    return tab, text, paths


def reader(payload) -> tuple[str, str]:
    """A ``POST /__cad/context/read`` body, checked: the conversation and its project folder."""
    if type(payload) is not dict or set(payload) != {"session", "cwd"}:
        raise ValueError("A read has a session and a cwd")
    session, cwd = payload["session"], payload["cwd"]
    if type(session) is not str or not session or len(session) > 128 or type(cwd) is not str or not os.path.isabs(cwd):
        raise ValueError("A read's session is a string and its cwd absolute")
    return session, cwd
