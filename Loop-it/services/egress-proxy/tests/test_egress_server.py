from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from typing import cast

import pytest
from fastapi.testclient import TestClient
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_agent_core.config import SecretConfigurationError
from loopit_egress import Category, EgressPolicy, EgressProxy, StaticPolicyResolver
from loopit_egress.server import EgressProxyServer, EgressSettings, create_admin_app

os.environ.setdefault("LOOPIT_AUDIT_EPHEMERAL", "1")


async def _origin(seen: list[bytes] | None = None) -> tuple[asyncio.AbstractServer, int]:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        data = await reader.read(65536)
        if seen is not None:
            seen.append(data)
        if data.startswith(b"GET"):
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
        else:
            writer.write(data)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    sock = server.sockets[0]
    return server, int(sock.getsockname()[1])


async def _proxy(
    origin_port: int,
) -> AsyncIterator[tuple[EgressProxyServer, int, InMemoryAuditSink]]:
    resolver = StaticPolicyResolver(
        {"lease": EgressPolicy(categories=(Category("package_registries", enabled=True),))}
    )
    audit = InMemoryAuditSink()
    server = EgressProxyServer(
        EgressProxy(resolver=resolver, audit=audit, byte_budget=4096),
        default_lease_id="lease",
        default_tenant_id="tenant",
        connect_override=lambda _host, _port: ("127.0.0.1", origin_port),
    )
    await server.start("127.0.0.1", 0)
    assert server._server is not None
    sockets = cast(list[object], server._server.sockets)  # type: ignore[attr-defined]
    port = int(sockets[0].getsockname()[1])  # type: ignore[attr-defined]
    try:
        yield server, port, audit
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_absolute_uri_get_is_forwarded(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_resolve(_host: str) -> tuple[str, ...]:
        return ("93.184.216.34",)

    monkeypatch.setattr("loopit_egress.server._resolve", fake_resolve)
    origin, origin_port = await _origin()
    try:
        async for _server, proxy_port, _audit in _proxy(origin_port):
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
            writer.write(
                b"GET http://registry.npmjs.org/pkg?token=secret HTTP/1.1\r\n"
                b"Host: registry.npmjs.org\r\n"
                b"X-Loopit-Lease: lease\r\n"
                b"X-Loopit-Tenant: tenant\r\n\r\n"
            )
            await writer.drain()
            response = await reader.read(65536)
            assert b"200 OK" in response
            assert response.endswith(b"ok")
            writer.close()
            await writer.wait_closed()
    finally:
        origin.close()
        await origin.wait_closed()


@pytest.mark.asyncio
async def test_sandbox_identity_headers_are_ignored_and_stripped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_resolve(_host: str) -> tuple[str, ...]:
        return ("93.184.216.34",)

    monkeypatch.setattr("loopit_egress.server._resolve", fake_resolve)
    seen: list[bytes] = []
    origin, origin_port = await _origin(seen)
    try:
        async for _server, proxy_port, audit in _proxy(origin_port):
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
            writer.write(
                b"GET http://registry.npmjs.org/pkg HTTP/1.1\r\n"
                b"Host: registry.npmjs.org\r\n"
                b"X-Loopit-Lease: victim-lease\r\n"
                b"X-Loopit-Tenant: victim-tenant\r\n\r\n"
            )
            await writer.drain()
            response = await reader.read(65536)
            assert b"200 OK" in response
            writer.close()
            await writer.wait_closed()

            assert audit.events[0].sandbox_lease_id == "lease"
            assert audit.events[0].tenant_id == "tenant"
            assert b"x-loopit-lease:" not in seen[0].lower()
            assert b"x-loopit-tenant:" not in seen[0].lower()
    finally:
        origin.close()
        await origin.wait_closed()


@pytest.mark.asyncio
async def test_denied_metadata_request_gets_uniform_403() -> None:
    origin, origin_port = await _origin()
    try:
        async for _server, proxy_port, _audit in _proxy(origin_port):
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
            writer.write(
                b"GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\n"
                b"Host: 169.254.169.254\r\n\r\n"
            )
            await writer.drain()
            response = await reader.read(65536)
            assert b"403 Forbidden" in response
            assert response.endswith(b"forbidden")
            writer.close()
            await writer.wait_closed()
    finally:
        origin.close()
        await origin.wait_closed()


def test_admin_healthz() -> None:
    assert TestClient(create_admin_app()).get("/healthz").status_code == 200


def test_settings_require_audit_dsn_unless_ephemeral_dev_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LOOPIT_AUDIT_DSN", raising=False)
    monkeypatch.delenv("LOOPIT_AUDIT_EPHEMERAL", raising=False)

    with pytest.raises(SecretConfigurationError):
        EgressSettings.from_env()


def test_settings_allow_explicit_ephemeral_audit_for_dev(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LOOPIT_AUDIT_DSN", raising=False)
    monkeypatch.setenv("LOOPIT_AUDIT_EPHEMERAL", "1")

    assert EgressSettings.from_env().audit_dsn == ""
