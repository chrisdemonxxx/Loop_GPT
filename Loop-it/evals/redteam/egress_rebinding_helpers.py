from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any, cast

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_egress import Category, EgressPolicy, EgressProxy, StaticPolicyResolver
from loopit_egress import server as egress_server
from loopit_egress.server import EgressProxyServer

BENIGN_IP = "93.184.216.34"
METADATA_IP = "169.254.169.254"


async def assert_dns_rebinding_attempt_is_refused(
    monkeypatch: pytest.MonkeyPatch,
    *,
    host: str,
    request: bytes,
) -> None:
    async def fake_metadata_origin(
        _reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nmetadata")
        await writer.drain()
        writer.close()

    origin = await asyncio.start_server(fake_metadata_origin, "127.0.0.1", 0)
    origin_port = int(origin.sockets[0].getsockname()[1])
    real_open_connection = asyncio.open_connection
    lookups = 0

    async def fake_resolve(candidate: str) -> tuple[str, ...]:
        nonlocal lookups
        if candidate == host:
            lookups += 1
            return (BENIGN_IP,) if lookups == 1 else (METADATA_IP,)
        return (candidate,)

    async def fake_open_connection(
        connect_host: str,
        _connect_port: int,
        *args: object,
        **kwargs: Any,
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        if connect_host == host:
            resolved = await egress_server._resolve(connect_host)
            if resolved == (METADATA_IP,):
                return await real_open_connection("127.0.0.1", origin_port, *args, **kwargs)
        raise OSError(f"refused test connection to {connect_host}")

    monkeypatch.setattr("loopit_egress.server._resolve", fake_resolve)
    monkeypatch.setattr("asyncio.open_connection", fake_open_connection)
    try:
        async for proxy_port in _allowing_proxy(host):
            reader, writer = await real_open_connection("127.0.0.1", proxy_port)
            writer.write(request)
            await writer.drain()
            response = await reader.read(65536)
            writer.close()
            await writer.wait_closed()

            assert b"403 Forbidden" in response
            assert b"metadata" not in response
            assert lookups == 1
    finally:
        origin.close()
        await origin.wait_closed()


async def _allowing_proxy(host: str) -> AsyncIterator[int]:
    server = EgressProxyServer(
        EgressProxy(
            resolver=StaticPolicyResolver(
                {
                    "lease": EgressPolicy(
                        categories=(Category("app_apis", enabled=True),),
                        extra_allow=frozenset({host}),
                    )
                }
            ),
            audit=InMemoryAuditSink(),
            byte_budget=4096,
        ),
        default_lease_id="lease",
        default_tenant_id="tenant",
    )
    await server.start("127.0.0.1", 0)
    assert server._server is not None
    sockets = cast(list[object], server._server.sockets)  # type: ignore[attr-defined]
    port = int(sockets[0].getsockname()[1])  # type: ignore[attr-defined]
    try:
        yield port
    finally:
        await server.stop()
