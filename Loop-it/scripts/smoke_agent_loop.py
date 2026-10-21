"""Live end-to-end run of the agent loop against real models.

The unit tests drive the loop with a scripted client, which proves the mechanics
and proves nothing about whether a real model can actually hold up its end of
the contract: emit a well-formed tool call, read an observation, and act on it.
This does that, with an in-memory file system standing in for the sandbox so no
generated code is ever executed (invariant I1 holds trivially here).

Usage::

    $env:HF_TOKEN = "hf_..."
    python scripts/smoke_agent_loop.py --bill-to red-kit
"""

from __future__ import annotations

import argparse
import os
import sys
import tomllib
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[1]
_CONFIG = tomllib.loads((_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
for _entry in _CONFIG["tool"]["pytest"]["ini_options"]["pythonpath"]:
    sys.path.insert(0, str(_ROOT / _entry))

from loopit_agent_core.audit import InMemoryAuditSink  # noqa: E402
from loopit_agent_core.budget import Budget  # noqa: E402
from loopit_agent_core.loop import AgentLoop  # noqa: E402
from loopit_agent_core.tools import ToolCall, ToolExecutor, ToolResult  # noqa: E402
from loopit_router import (  # noqa: E402
    ModelRouter,
    OpenAICompatibleUpstream,
    QuotaLedger,
    RouterModelClient,
    TenantQuota,
    UpstreamEndpoint,
    huggingface_router_policy,
)
from loopit_router.upstream import StaticSecretResolver  # noqa: E402

CREDENTIAL_REF = "secrets://models/hf-router"

#: Stands in for the project checkout. The bug is real: the function returns the
#: wrong value, and the test that proves it is already written.
FILES: dict[str, str] = {
    "src/calc.py": "def add(a, b):\n    return a - b\n",
    "tests/test_calc.py": (
        "from src.calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n"
    ),
}

SYSTEM_PROMPT = """You are a software engineer working in a sandboxed repository.

You act only by emitting a single JSON tool call per turn. Never explain, never
apologise, never emit prose — emit only the JSON object.

Available tools:
- read_file   args: {"path": "<project-relative path>"}
- search_code args: {"query": "<text>"}
- apply_patch args: {"patch": "<unified diff>"}
- run_shell   args: {"command": "<shell command>"}

Rules for apply_patch: the patch must be a unified diff with a ---/+++ header
and one @@ hunk whose context lines match the file exactly as you read it.

Work in small steps: read before you patch, and run the tests after patching.
"""

TASK_GOAL = (
    "The test at tests/test_calc.py fails. Read src/calc.py, fix the bug in the "
    "add function with apply_patch, then run the tests with `pytest -q`."
)


def build_executor(log: list[str]) -> ToolExecutor:
    """Handlers backed by the dict above rather than a real sandbox."""

    def read_file(call: ToolCall) -> ToolResult:
        path = str(call.args["path"])
        log.append(f"read_file {path}")
        if path not in FILES:
            return ToolResult(ok=False, output=f"no such file: {path}")
        return ToolResult(ok=True, output=FILES[path])

    def search_code(call: ToolCall) -> ToolResult:
        query = str(call.args["query"])
        log.append(f"search_code {query!r}")
        hits = [p for p, body in FILES.items() if query in body]
        return ToolResult(ok=True, output="\n".join(hits) or "no matches")

    def apply_patch(call: ToolCall) -> ToolResult:
        patch = str(call.args["patch"])
        log.append("apply_patch")
        # Deliberately forgiving: this smoke test asks whether the model can
        # produce a *correct edit*, not whether it can satisfy a strict differ.
        # The real patch engine lives in packages/patch and is tested there.
        if "a + b" in patch:
            FILES["src/calc.py"] = "def add(a, b):\n    return a + b\n"
            return ToolResult(ok=True, output="applied 1 hunk to src/calc.py")
        return ToolResult(ok=False, output="patch did not apply: context mismatch")

    def run_shell(call: ToolCall) -> ToolResult:
        command = str(call.args["command"])
        log.append(f"run_shell {command!r}")
        if "pytest" not in command:
            return ToolResult(ok=True, output="")
        if "a + b" in FILES["src/calc.py"]:
            return ToolResult(ok=True, output="1 passed in 0.01s")
        return ToolResult(
            ok=False,
            output="FAILED tests/test_calc.py::test_add - assert -1 == 5\n1 failed in 0.01s",
        )

    return ToolExecutor(
        {
            "read_file": read_file,
            "search_code": search_code,
            "apply_patch": apply_patch,
            "run_shell": run_shell,
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://router.huggingface.co")
    parser.add_argument("--bill-to", default=os.environ.get("HF_BILL_TO"))
    parser.add_argument("--difficulty", default="implementation")
    parser.add_argument("--max-iterations", type=int, default=8)
    args = parser.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        print("HF_TOKEN is not set.", file=sys.stderr)
        return 2

    ledger = QuotaLedger()
    ledger.set_quota(TenantQuota(tenant_id="smoke", credit_limit=1.0))
    audit = InMemoryAuditSink()
    router = ModelRouter(
        policy=huggingface_router_policy(CREDENTIAL_REF),
        upstream=OpenAICompatibleUpstream(
            UpstreamEndpoint(base_url=args.base_url, bill_to=args.bill_to, scale_up_timeout_s=600)
        ),
        ledger=ledger,
        secrets=StaticSecretResolver({CREDENTIAL_REF: token}),
        audit=audit,
    )

    log: list[str] = []

    def verify(call: ToolCall, observation: Any) -> str | None:
        """Green only when the suite actually passes."""
        if call.tool == "run_shell" and "passed" in observation.content:
            return "tests pass"
        return None

    loop = AgentLoop(
        model=RouterModelClient(router, tenant_id="smoke", run_id="run-1", task_id="task-1"),
        executor=build_executor(log),
        audit=audit,
        tenant_id="smoke",
        project_id="proj-1",
        run_id="run-1",
        task_id="task-1",
        budget=Budget(max_iterations=args.max_iterations),
        verify=verify,
        difficulty=args.difficulty,
    )

    model = router._policy.candidates(args.difficulty)[0].name
    print(f"model    : {model}")
    print(f"bill-to  : {args.bill_to or '(personal account)'}")
    print(f"before   : {FILES['src/calc.py']!r}\n")

    result = loop.run(SYSTEM_PROMPT, TASK_GOAL)

    print("tool calls the model actually made:")
    for index, entry in enumerate(log, 1):
        print(f"  {index}. {entry}")

    print(f"\nafter    : {FILES['src/calc.py']!r}")
    print(f"outcome  : {result.outcome}")
    print(f"iterations: {result.iterations}")
    print(f"summary  : {result.summary}")
    print(f"usage    : {result.usage}")
    print(f"spent    : {ledger.spent('smoke'):.6f} credits (USD)")
    print(f"audited  : {len(audit.events)} events")

    fixed = "a + b" in FILES["src/calc.py"]
    print(f"\nRESULT   : {'PASS' if result.succeeded and fixed else 'FAIL'}")
    return 0 if result.succeeded and fixed else 1


if __name__ == "__main__":
    raise SystemExit(main())
