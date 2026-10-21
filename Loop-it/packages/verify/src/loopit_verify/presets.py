"""Ready-made check sets for the supported stacks.

Verification only works if the checks are the ones the project actually has.
These presets encode the commands the frozen stack templates ship with, so the
agent never has to guess a test command — guessing produces a "verified" build
whose verification did nothing.

Every command here is non-interactive and non-watching. A watch-mode command
passes its timeout and consumes the sandbox's whole wall-clock budget while
appearing to work.
"""

from __future__ import annotations

from .checks import Check, Level


def node_typescript_checks(*, package_manager: str = "pnpm") -> tuple[Check, ...]:
    """L0/L1 checks for the React + TypeScript half of the frozen stack."""
    pm = package_manager
    return (
        Check(
            name="typecheck",
            level=Level.L0_STATIC,
            command=(pm, "run", "typecheck"),
            timeout_seconds=180,
        ),
        Check(
            name="lint",
            level=Level.L0_STATIC,
            command=(pm, "run", "lint"),
            timeout_seconds=180,
        ),
        Check(
            name="unit-tests",
            level=Level.L1_TESTS,
            command=(pm, "run", "test", "--", "--run"),
            timeout_seconds=600,
        ),
        Check(
            name="build",
            level=Level.L1_TESTS,
            command=(pm, "run", "build"),
            timeout_seconds=600,
        ),
    )


def python_checks() -> tuple[Check, ...]:
    """L0/L1 checks for the Python half of the frozen stack."""
    return (
        Check(
            name="ruff",
            level=Level.L0_STATIC,
            command=("ruff", "check", "."),
            timeout_seconds=120,
        ),
        Check(
            name="mypy",
            level=Level.L0_STATIC,
            command=("mypy", "."),
            timeout_seconds=300,
        ),
        Check(
            name="pytest",
            level=Level.L1_TESTS,
            command=("pytest", "-q"),
            timeout_seconds=600,
        ),
    )


def smoke_check(url: str = "http://localhost:3000") -> Check:
    """L2: does the app actually boot and answer?

    Compiling and passing tests is not the same as running. This is the cheapest
    check that catches a project which builds green and serves a stack trace.
    """
    return Check(
        name="smoke",
        level=Level.L2_RUNTIME,
        command=("curl", "--fail", "--silent", "--show-error", "--max-time", "20", url),
        timeout_seconds=60,
    )
