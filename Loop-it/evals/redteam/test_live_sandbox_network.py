"""Optional live red-team probes inside a provisioned sandbox.

Offline red-team tests exercise policy objects. These tests execute the negative
network probes from ``loopit_sandbox_network`` through a real sandbox runtime
when an operator explicitly enables them.
"""

from __future__ import annotations

import os

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_agent_core.config import require_secret
from loopit_evals.executors import DockerRuntimeWorkspaceFactory, InfrastructureUnavailable
from loopit_sandbox_network import Endpoint, NetworkPolicyConfig, verification_probes
from loopit_scheduler.factory import SchedulerSettings, create_scheduler


def live_enabled() -> bool:
    return os.environ.get("LOOPIT_LIVE_SANDBOX_REDTEAM") == "1"


def live_configured_provider() -> str:
    return os.environ.get("LOOPIT_SANDBOX_PROVIDER", "memory").lower()


pytestmark = pytest.mark.skipif(
    not live_enabled(), reason="set LOOPIT_LIVE_SANDBOX_REDTEAM=1 to run live sandbox probes"
)


def test_live_sandbox_network_probes_fail_closed() -> None:
    provider = live_configured_provider()
    if provider != "docker":
        pytest.skip("live red-team runtime attachment is currently wired for docker sandboxes")

    settings = SchedulerSettings.from_env()
    scheduler = create_scheduler(audit=InMemoryAuditSink(), settings=settings)
    assignment = None
    workspace = None
    try:
        assignment = scheduler.acquire(
            tenant_id="redteam-tenant",
            run_id="redteam-run",
            project_id="redteam-project",
            base_checkpoint_id="redteam-base",
            ttl_seconds=300,
        )
        workspace = DockerRuntimeWorkspaceFactory(
            root_signing_key=require_secret(os.environ, "LOOPIT_SANDBOX_SIGNING_KEY").encode()
        )(assignment, tenant_id="redteam-tenant", run_id="redteam-run")
        config = NetworkPolicyConfig(
            egress_proxy=Endpoint(os.environ.get("LOOPIT_EGRESS_PROXY_ADDR", "192.0.2.10"), 3128),
            resolver=Endpoint(os.environ.get("LOOPIT_SANDBOX_RESOLVER_ADDR", "192.0.2.53"), 53),
        )
        for probe in verification_probes(config):
            result = workspace.run_shell(
                _probe_command(probe.target, probe.port),
                cwd=".",
                timeout_seconds=20,
                output_bytes=4000,
            )
            assert not result.ok, f"{probe.name} unexpectedly reached {probe.target}:{probe.port}"

        escape = workspace.run_shell(
            "python -c \"from pathlib import Path; print(Path('/').resolve())\"",
            cwd=".",
            timeout_seconds=20,
            output_bytes=4000,
        )
        assert escape.ok, "basic command execution must work before escape assertions are useful"
        traversal = workspace.read_file("../../etc/passwd", max_bytes=2000)
        assert "REJECTED" in traversal[0] or "outside" in traversal[0]
    except InfrastructureUnavailable as error:
        pytest.skip(str(error))
    finally:
        if workspace is not None:
            close = getattr(workspace.client, "close", None)
            if callable(close):
                close()
        if assignment is not None:
            scheduler.release(
                assignment.lease.lease_id,
                tenant_id=assignment.lease.tenant_id,
                reason="redteam_finished",
            )
        scheduler.shutdown()


def _probe_command(target: str, port: int) -> str:
    if port == 53:
        script = (
            "import socket; "
            "s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); "
            "s.settimeout(3); "
            f"s.sendto(b'x', ('{target}', {port})); "
            "s.recvfrom(1)"
        )
    else:
        script = (
            f"import socket; s=socket.create_connection(('{target}', {port}), timeout=3); s.close()"
        )
    return f'python -c "{script}"'
