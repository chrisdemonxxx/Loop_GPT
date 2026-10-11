"""Build the loop-gnome-desktop template on E2B.

Usage:
    uv run python build.py            # or: python build.py with e2b installed

Requires E2B_API_KEY in the environment (or a local .env).
"""

import os

from dotenv import load_dotenv
from e2b import Template, default_build_logger
from template import template_with_user_workdir

load_dotenv()

if not os.environ.get("E2B_API_KEY"):
    raise SystemExit("E2B_API_KEY is required")

Template.build(
    template_with_user_workdir,
    alias="loop-gnome-desktop",
    cpu_count=8,
    memory_mb=8192,
    on_build_logs=default_build_logger(),
)
