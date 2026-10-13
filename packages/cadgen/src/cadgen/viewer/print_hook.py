"""Print projects for the open file, through a command the person names (env ``CADGEN_PRINT_COMMAND``).

The Viewer knows nothing about slicers or a project's print settings; a workspace that does names one executable
in ``CADGEN_PRINT_COMMAND``, and the printer button in the navbar asks it:

    <command> --list <absolute path>          -> JSON {"projects": [{"file", "title"}, ...]}, the one to open first
    <command> --open <absolute path> <file>   -> builds that project and opens it in the slicer; JSON {"opened": path}

Unset, the Viewer has no printer button (``projects`` answers an empty list). Never a shell: the command and each
argument are one argv entry. The command's stdout must end with its JSON line; anything printed before it is ignored.
"""
import json
import os
import shlex
import subprocess

LIST_SECONDS = 60
OPEN_SECONDS = 900          # building a large print project can take minutes


def command() -> list[str] | None:
    raw = (os.environ.get("CADGEN_PRINT_COMMAND") or "").strip()
    return shlex.split(raw) if raw else None


def _run(argv: list[str], seconds: int) -> dict:
    done = subprocess.run(argv, capture_output=True, text=True, timeout=seconds)
    if done.returncode != 0:
        detail = (done.stderr or done.stdout or "").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else "the print command failed (exit %d)" % done.returncode)
    lines = [line for line in done.stdout.strip().splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("the print command printed nothing")
    return json.loads(lines[-1])


def projects(path: str) -> dict:
    """The print projects for ``path``: {"projects": [...]} -- empty when no command is named."""
    cmd = command()
    if not cmd:
        return {"projects": []}
    answer = _run(cmd + ["--list", path], LIST_SECONDS)
    rows = answer.get("projects") if isinstance(answer, dict) else None
    if not isinstance(rows, list):
        raise RuntimeError("the print command's --list answer has no projects")
    return {"projects": [{"file": str(r.get("file")), "title": str(r.get("title") or r.get("file"))}
                         for r in rows if isinstance(r, dict) and r.get("file")]}


def open_project(path: str, file: str) -> dict:
    """Build ``file`` for ``path`` and open it in the slicer."""
    cmd = command()
    if not cmd:
        raise RuntimeError("no print command is set (CADGEN_PRINT_COMMAND)")
    return _run(cmd + ["--open", path, file], OPEN_SECONDS)
