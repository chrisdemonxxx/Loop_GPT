"""Tests for environment-driven sandbox provider selection."""

from __future__ import annotations

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_scheduler import (
    DockerProvider,
    E2BProvider,
    InMemoryProvider,
    ProviderConfigurationError,
    SchedulerSettings,
    create_sandbox_provider,
    create_scheduler,
)


def test_factory_defaults_to_the_in_memory_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOOPIT_SANDBOX_PROVIDER", raising=False)

    assert isinstance(create_sandbox_provider(), InMemoryProvider)


def test_factory_selects_docker_from_settings() -> None:
    provider = create_sandbox_provider(
        SchedulerSettings(provider="docker", docker_image="loopit-sandbox:test")
    )

    assert isinstance(provider, DockerProvider)


def test_factory_selects_e2b_from_settings() -> None:
    provider = create_sandbox_provider(
        SchedulerSettings(provider="e2b", e2b_template_id="tmpl_loopit")
    )

    assert isinstance(provider, E2BProvider)


def test_factory_rejects_unknown_provider() -> None:
    with pytest.raises(ProviderConfigurationError, match="memory, docker, or e2b"):
        create_sandbox_provider(SchedulerSettings(provider="firecracker"))


def test_settings_parse_pool_and_caps_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_SANDBOX_PROVIDER", "memory")
    monkeypatch.setenv("LOOPIT_SANDBOX_POOL_TARGET_SIZE", "0")
    monkeypatch.setenv("LOOPIT_SANDBOX_POOL_MAX_LIVE", "7")
    monkeypatch.setenv("LOOPIT_SANDBOX_MEMORY_MIB", "512")
    monkeypatch.setenv("LOOPIT_SANDBOX_TENANT_CONCURRENCY", "2")

    settings = SchedulerSettings.from_env()
    scheduler = create_scheduler(audit=InMemoryAuditSink(), settings=settings)

    assert settings.pool_target_size == 0
    assert settings.pool_max_live == 7
    assert settings.caps.memory_mib == 512
    assert scheduler.tenant_lease_count("tenant") == 0


def test_settings_reject_non_integer_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_SANDBOX_POOL_TARGET_SIZE", "many")

    with pytest.raises(ProviderConfigurationError, match="must be an integer"):
        SchedulerSettings.from_env()
