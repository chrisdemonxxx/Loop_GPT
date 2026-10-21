"""Command-line entrypoint for the in-sandbox runtime."""

from __future__ import annotations

import argparse
import base64
import binascii
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from loopit_agent_core.audit import InMemoryAuditSink
from loopit_sandbox_sdk import Lease, ResourceCaps

from .runtime import JsonLineRuntime, RuntimeConfig, RuntimeLimits, SandboxRuntime


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Loop-it in-sandbox agent runtime.")
    parser.add_argument("--workspace", default=os.environ.get("LOOPIT_WORKSPACE", "."))
    parser.add_argument("--signing-key-env", default="LOOPIT_SANDBOX_SIGNING_KEY")
    parser.add_argument("--lease-id", default=os.environ.get("LOOPIT_LEASE_ID", "lease"))
    parser.add_argument("--tenant-id", default=os.environ.get("LOOPIT_TENANT_ID", "tenant"))
    parser.add_argument("--run-id", default=os.environ.get("LOOPIT_RUN_ID", "run"))
    parser.add_argument(
        "--base-checkpoint-id",
        default=os.environ.get("LOOPIT_BASE_CHECKPOINT_ID", "checkpoint"),
    )
    parser.add_argument("--lease-expires-at", default=os.environ.get("LOOPIT_LEASE_EXPIRES_AT"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(list(sys.argv[1:] if argv is None else argv))
    signing_value = os.environ.get(args.signing_key_env, "")
    if not signing_value:
        print(f"{args.signing_key_env} is required", file=sys.stderr)
        return 2
    # The env channel transports the lease-derived key base64-encoded (the
    # control plane cannot pass arbitrary bytes through `docker exec -e`),
    # so decode strictly: RuntimeConfig.signing_key must hold the exact raw
    # bytes the dispatch side signed with.
    try:
        signing_key = base64.b64decode(signing_value, validate=True)
    except (binascii.Error, ValueError) as error:
        print(f"{args.signing_key_env} is not valid base64: {error}", file=sys.stderr)
        return 2

    expires_at = (
        datetime.fromisoformat(args.lease_expires_at.replace("Z", "+00:00"))
        if args.lease_expires_at
        else datetime.now(UTC).replace(year=datetime.now(UTC).year + 1)
    )
    lease = Lease(
        lease_id=args.lease_id,
        tenant_id=args.tenant_id,
        run_id=args.run_id,
        base_checkpoint_id=args.base_checkpoint_id,
        expires_at=expires_at,
        caps=ResourceCaps(),
    )
    runtime = SandboxRuntime(
        RuntimeConfig(
            workspace=Path(args.workspace),
            lease=lease,
            signing_key=signing_key,
            audit_sink=InMemoryAuditSink(),
            limits=RuntimeLimits(),
        )
    )
    JsonLineRuntime(runtime).serve(sys.stdin, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
