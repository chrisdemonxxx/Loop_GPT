"""Start the local preview API.

Usage::

    $env:HF_TOKEN = "hf_..."
    python -m loopit_api --bill-to red-kit

Without ``HF_TOKEN`` the server starts in offline mode: the interface works and
every run is labelled offline, because a scripted client is a demo of the UI and
should never be mistaken for a demo of the platform.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import uvicorn

from .app import create_app, live_model_factory, offline_model_factory


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--base-url", default=os.environ.get("HF_BASE_URL", "https://router.huggingface.co")
    )
    parser.add_argument("--bill-to", default=os.environ.get("HF_BILL_TO"))
    parser.add_argument(
        "--projects",
        default=os.environ.get("LOOPIT_PROJECTS", ".loopit/projects"),
        help="where run workspaces are created",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="run the UI against a scripted client; no model is called",
    )
    parser.add_argument(
        "--run-execution-mode",
        choices=("orchestrator", "local"),
        default=os.environ.get("LOOPIT_RUN_EXECUTION_MODE"),
        help=(
            "run owner to use. Use 'local' only as the explicit offline fallback; "
            "otherwise apps/api starts runs through Temporal."
        ),
    )
    args = parser.parse_args(argv)

    token = os.environ.get("HF_TOKEN")
    if args.offline or not token:
        if not args.offline:
            print("HF_TOKEN is not set - starting in offline mode.", file=sys.stderr)
            print("Runs will use a scripted client and no model will be called.\n", file=sys.stderr)
        app = create_app(
            projects_root=Path(args.projects),
            model_factory=offline_model_factory(),
            offline=True,
            execution_mode=args.run_execution_mode or "local",
        )
    else:
        app = create_app(
            projects_root=Path(args.projects),
            model_factory=live_model_factory(
                base_url=args.base_url, bill_to=args.bill_to, token=token
            ),
            execution_mode=args.run_execution_mode or "orchestrator",
        )

    mode = args.run_execution_mode or ("local" if args.offline or not token else "orchestrator")
    print(f"Loop-it preview API on http://{args.host}:{args.port}")
    print(f"Workspaces: {Path(args.projects).resolve()}")
    print(f"Run execution mode: {mode}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
