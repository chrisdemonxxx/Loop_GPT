"""Kick off the loop-gnome-desktop build in the background (server-side —
no client context to cancel) and print the BuildInfo for polling."""

import os

from dotenv import load_dotenv
from e2b import Template
from template import template_with_user_workdir

load_dotenv()

if not os.environ.get("E2B_API_KEY"):
    raise SystemExit("E2B_API_KEY is required")

info = Template.build_in_background(
    template_with_user_workdir,
    alias="loop-gnome-desktop",
    cpu_count=8,
    memory_mb=8192,
    # A previous client-crash canceled a build mid-apt-transaction and E2B
    # cached that partial layer; a clean rebuild must not reuse it.
    skip_cache=True,
)
print(f"TEMPLATE_ID={info.template_id}")
print(f"BUILD_ID={info.build_id}")
