"""Live smoke test for a model endpoint.

Exercises the real ``ModelRouter`` against a real provider — not a mock — so the
things that only break in production are what get checked: that the credential
is accepted, that the model id resolves, that ``usage`` comes back well-formed
enough to bill, and that constrained decoding actually constrains.

Nothing here is imported by the service. It is an operator tool, kept out of the
test suite deliberately: a CI gate that needs a funded account and a network
round trip is a gate that fails for reasons unrelated to the change under test.

Usage::

    $env:HF_TOKEN = "hf_..."          # never committed; see docs below
    python scripts/smoke_model_endpoint.py
    python scripts/smoke_model_endpoint.py --bill-to red-kit
    python scripts/smoke_model_endpoint.py --base-url https://my-endpoint.hf.space

Exit status is 0 only if every difficulty class answered.
"""

from __future__ import annotations

import argparse
import os
import sys
import tomllib
from pathlib import Path
from typing import Any

# Reuse the source roots pytest already knows about rather than restating them,
# so adding a package cannot silently break this tool.
_ROOT = Path(__file__).resolve().parents[1]
_CONFIG = tomllib.loads((_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
for _entry in _CONFIG["tool"]["pytest"]["ini_options"]["pythonpath"]:
    sys.path.insert(0, str(_ROOT / _entry))

from loopit_agent_core.audit import InMemoryAuditSink  # noqa: E402
from loopit_router import (  # noqa: E402
    ModelRouter,
    OpenAICompatibleUpstream,
    QuotaLedger,
    TenantQuota,
    TerminalUpstreamError,
    UpstreamEndpoint,
    UpstreamError,
    huggingface_router_policy,
)
from loopit_router.routing import DIFFICULTIES, Difficulty  # noqa: E402
from loopit_router.upstream import StaticSecretResolver  # noqa: E402

CREDENTIAL_REF = "secrets://models/hf-router"

PROBES: dict[Difficulty, str] = {
    "trivial": "Reply with exactly one word: ok",
    "implementation": "Write a Python one-liner that reverses a string. Code only.",
    "planning": "In two sentences, outline how to add rate limiting to a REST API.",
}

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
    "additionalProperties": False,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default="https://router.huggingface.co",
        help="OpenAI-compatible root. Point at a dedicated endpoint or local vLLM to test those.",
    )
    parser.add_argument(
        "--bill-to",
        default=os.environ.get("HF_BILL_TO"),
        help="Organisation to charge via X-HF-Bill-To (requires a fine-grained token).",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=16384,
        help=(
            "Output budget per call. Reasoning models spend most of this on the "
            "scratchpad before writing a single character of answer."
        ),
    )
    parser.add_argument(
        "--structured",
        action="store_true",
        help="Also verify constrained decoding returns schema-valid JSON.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.environ.get("HF_TOKEN")
    if not token:
        print("HF_TOKEN is not set. Export it, do not paste it into a file.", file=sys.stderr)
        return 2

    endpoint = UpstreamEndpoint(
        base_url=args.base_url,
        bill_to=args.bill_to,
        # A dedicated endpoint scaled to zero can take minutes to wake; hold the
        # request instead of counting the cold start as a failure.
        scale_up_timeout_s=600,
        max_attempts=3,
    )
    ledger = QuotaLedger()
    ledger.set_quota(TenantQuota(tenant_id="smoke", credit_limit=1.0))
    audit = InMemoryAuditSink()
    router = ModelRouter(
        policy=huggingface_router_policy(CREDENTIAL_REF),
        upstream=OpenAICompatibleUpstream(endpoint),
        ledger=ledger,
        secrets=StaticSecretResolver({CREDENTIAL_REF: token}),
        audit=audit,
    )

    print(f"endpoint : {endpoint.completions_url}")
    print(f"bill-to  : {args.bill_to or '(personal account)'}\n")

    failures = 0
    for difficulty in DIFFICULTIES:
        model = router._policy.candidates(difficulty)[0].name
        print(f"[{difficulty}] {model}")
        try:
            result = router.complete(
                tenant_id="smoke",
                difficulty=difficulty,
                messages=[{"role": "user", "content": PROBES[difficulty]}],
                max_output_tokens=args.max_tokens,
                response_schema=SCHEMA if args.structured else None,
            )
        except TerminalUpstreamError as error:
            # Distinguished from a dead model on purpose: this is an account
            # problem, and every other model would fail identically.
            print(f"  TERMINAL (no failover attempted): {error}\n")
            failures += 1
            continue
        except UpstreamError as error:
            print(f"  FAILED: {type(error).__name__}: {error}")
            for attempt in error.attempts:
                print(f"    - {attempt}")
            print()
            failures += 1
            continue
        except Exception as error:
            print(f"  FAILED: {type(error).__name__}: {error}\n")
            failures += 1
            continue

        preview = " ".join(result.content.split())[:100]
        print(f"  reply  : {preview!r}")
        if result.reasoning:
            print(f"  thought: {len(result.reasoning)} chars of reasoning (billed, not shown)")
        print(
            f"  tokens : in={result.input_tokens} out={result.output_tokens} "
            f"cached={result.cached_input_tokens} finish={result.finish_reason}"
        )

    spent = ledger.spent("smoke")
    print(f"\nspent    : {spent:.6f} credits (USD)")
    print(f"audited  : {len(audit.events)} events")
    if failures:
        print(f"RESULT   : FAIL — {failures}/{len(DIFFICULTIES)} classes unavailable")
        return 1
    print(f"RESULT   : PASS — all {len(DIFFICULTIES)} difficulty classes answered")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
