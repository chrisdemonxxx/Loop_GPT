"""User-facing shell execution for the build terminal.

This is intentionally separate from :mod:`loopit_api.workspace`, which houses the
agent's tool contract. Invariant I1 forbids *model-authored* commands from
running on the control plane, so ``Workspace.run_shell`` always refuses. The
terminal here runs *operator-authored* commands in the operator's own project
workspace — the same commands the operator could run if they opened the directory
on their own machine.

v1 is non-interactive: commands run to completion with captured output. No PTY,
no persistent shell session, no command history on the server.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any


class TerminalError(Exception):
    """Something went wrong running the command, independent of its exit code."""


#: Identity scope required to use the terminal. The command runs on the API
#: host with the service's own privileges, so the parent (Loop-GPT) grants this
#: to platform admins only until commands run in a per-project sandbox.
TERMINAL_SCOPE = "build:terminal"

MAX_OUTPUT_CHARS = 64_000
DEFAULT_TIMEOUT_SECONDS = 60
MAX_TIMEOUT_SECONDS = 300


def run_user_command(
    root: Path,
    command: str,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    max_output_chars: int = MAX_OUTPUT_CHARS,
) -> dict[str, Any]:
    """Run one shell command in ``root`` and return captured output.

    The command runs with ``shell=True`` so operators can use pipes, redirects,
    and common one-liners. The working directory is locked to ``root``. Output
    is truncated to ``max_output_chars`` per stream and the run is killed after
    ``timeout_seconds``.
    """
    timeout_seconds = min(max(timeout_seconds, 1), MAX_TIMEOUT_SECONDS)
    start = time.monotonic()
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=root,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        duration = time.monotonic() - start
        stdout = result.stdout
        stderr = result.stderr
        truncated = len(stdout) > max_output_chars or len(stderr) > max_output_chars
        return {
            "command": command,
            "exit_code": result.returncode,
            "stdout": stdout[:max_output_chars],
            "stderr": stderr[:max_output_chars],
            "duration_seconds": round(duration, 3),
            "truncated": truncated,
        }
    except subprocess.TimeoutExpired as exc:
        duration = time.monotonic() - start
        return {
            "command": command,
            "exit_code": -1,
            "stdout": (exc.stdout or "")[:max_output_chars],
            "stderr": (f"timed out after {timeout_seconds}s\n" + (exc.stderr or ""))[
                :max_output_chars
            ],
            "duration_seconds": round(duration, 3),
            "truncated": True,
        }
    except OSError as exc:
        return {
            "command": command,
            "exit_code": -2,
            "stdout": "",
            "stderr": f"could not run command: {exc}",
            "duration_seconds": round(time.monotonic() - start, 3),
            "truncated": False,
        }


__all__ = ["run_user_command", "TerminalError", "MAX_OUTPUT_CHARS", "DEFAULT_TIMEOUT_SECONDS"]
