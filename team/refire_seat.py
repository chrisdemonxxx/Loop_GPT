#!/usr/bin/env python
"""Detached re-fire of a Hermes seat (v2: new console so the child's std handles land).

Usage: python refire_seat2.py <profile> <project_dir> <ask_file> <log_file> <note_file>

Flags: CREATE_NEW_PROCESS_GROUP | CREATE_NEW_CONSOLE (0x200|0x10). A new console
detaches the child from the caller's job/console, while the redirected std handles
(open file) are what the child actually inherits -- unlike DETACHED_PROCESS, which
gave 0-byte logs on the v1 fire even though the seat's artifacts landed.
"""
import subprocess
import sys
from pathlib import Path

HERMES = r"C:\Users\chris\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"


def main() -> int:
    profile, project, ask, log, note = sys.argv[1:6]
    prompt = Path(ask).read_text(encoding="utf-8") + "\n\n" + Path(note).read_text(encoding="utf-8")

    logp = Path(log)
    logp.parent.mkdir(parents=True, exist_ok=True)
    fh = open(logp, "wb", buffering=0)

    flags = 0x00000200 | 0x00000010  # CREATE_NEW_PROCESS_GROUP | CREATE_NEW_CONSOLE
    p = subprocess.Popen(
        [HERMES, "-p", profile, "--in", project, "-z", prompt],
        cwd=project,
        stdin=subprocess.DEVNULL,
        stdout=fh,
        stderr=subprocess.STDOUT,
        creationflags=flags,
        close_fds=True,
    )
    print("PID %d  %s  -> %s (flags=NEW_CONSOLE|NEW_GROUP)" % (p.pid, profile, logp))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
