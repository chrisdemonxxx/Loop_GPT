"""Asyncio forwarding proxy listener for sandbox egress."""

from __future__ import annotations

import asyncio
import logging
import os
import socket
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI
from loopit_agent_core.audit import AuditEvent, AuditSink
from loopit_agent_core.config import SecretConfigurationError, require_secret
from loopit_store import AuditStore, InMemoryAuditStore, PostgresAppendOnlyAuditSink
from loopit_store.postgres import connect
from loopit_telemetry import add_loopit_telemetry, configure_telemetry

from .policy import Category, EgressPolicy
from .proxy import EgressProxy, EgressRequest, StaticPolicyResolver

LOG = logging.getLogger("loopit.egress")
DENY = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\nConnection: close\r\n\r\nforbidden"

ConnectOverride = Callable[[str, int], tuple[str, int]]


@dataclass(frozen=True, slots=True)
class EgressSettings:
    host: str = "0.0.0.0"  # noqa: S104 - sandbox-facing listener default.
    port: int = 3128
    admin_host: str = "127.0.0.1"
    admin_port: int = 8128
    lease_id: str = "dev-lease"
    tenant_id: str = "dev-tenant"
    allow_package_registries: bool = True
    router_host: str = "router.internal.loopit"
    byte_budget: int = 2 * 1024 * 1024 * 1024
    audit_dsn: str = ""

    @classmethod
    def from_env(cls) -> EgressSettings:
        return cls(
            host=os.environ.get("LOOPIT_EGRESS_HOST", "0.0.0.0"),  # noqa: S104
            port=int(os.environ.get("LOOPIT_EGRESS_PORT", "3128")),
            admin_host=os.environ.get("LOOPIT_EGRESS_ADMIN_HOST", "127.0.0.1"),
            admin_port=int(os.environ.get("LOOPIT_EGRESS_ADMIN_PORT", "8128")),
            lease_id=os.environ.get("LOOPIT_EGRESS_DEFAULT_LEASE_ID", "dev-lease"),
            tenant_id=os.environ.get("LOOPIT_EGRESS_DEFAULT_TENANT_ID", "dev-tenant"),
            allow_package_registries=_env_bool("LOOPIT_EGRESS_ALLOW_PACKAGE_REGISTRIES", True),
            router_host=os.environ.get("LOOPIT_ROUTER_HOSTNAME", "router.internal.loopit"),
            byte_budget=int(
                os.environ.get("LOOPIT_EGRESS_BYTE_BUDGET", str(2 * 1024 * 1024 * 1024))
            ),
            audit_dsn=_audit_dsn_from_env(),
        )


class StoreAuditSink:
    def __init__(self, store: AuditStore) -> None:
        self._store = store

    def emit(self, event: AuditEvent) -> None:
        self._store.append(event)


class EgressProxyServer:
    def __init__(
        self,
        proxy: EgressProxy,
        *,
        default_lease_id: str,
        default_tenant_id: str,
        connect_override: ConnectOverride | None = None,
    ) -> None:
        self._proxy = proxy
        self._default_lease_id = default_lease_id
        self._default_tenant_id = default_tenant_id
        self._connect_override = connect_override
        self._server: asyncio.AbstractServer | None = None

    async def start(self, host: str, port: int) -> None:
        self._server = await asyncio.start_server(self.handle_client, host, port)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def serve_forever(self, host: str, port: int) -> None:
        await self.start(host, port)
        assert self._server is not None
        async with self._server:
            await self._server.serve_forever()

    async def handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            first, headers_raw = head.split(b"\r\n", 1)
            method, target, _version = first.decode("latin1").split(" ", 2)
            headers = _parse_headers(headers_raw.decode("latin1"))
            lease_id = self._default_lease_id
            tenant_id = self._default_tenant_id
            body = await _read_body(reader, int(headers.get("content-length", "0")))
            host, port, url = _target(method, target, headers)
            resolved = await _resolve(host)
            decision = self._proxy.handle(
                EgressRequest(
                    lease_id=lease_id,
                    tenant_id=tenant_id,
                    method=method,
                    url=url,
                    resolved_ips=resolved,
                    request_bytes=len(head) + len(body),
                )
            )
            if not decision.allowed:
                writer.write(DENY)
                await writer.drain()
                return

            connect_host, connect_port = (
                self._connect_override(host, port)
                if self._connect_override
                else (_validated_connect_host(resolved), port)
            )
            upstream_reader, upstream_writer = await asyncio.open_connection(
                connect_host, connect_port
            )
            if method.upper() == "CONNECT":
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
                await _tunnel(reader, writer, upstream_reader, upstream_writer)
                return

            path = _origin_form(target)
            filtered = _strip_proxy_headers(headers)
            filtered["host"] = headers.get("host", f"{host}:{port}")
            request = _format_request(method, path, filtered, body)
            upstream_writer.write(request)
            await upstream_writer.drain()
            await _copy(upstream_reader, writer)
        except Exception as exc:
            LOG.warning("egress request failed: %s", exc)
            if not writer.is_closing():
                writer.write(DENY)
                await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()


def create_proxy(settings: EgressSettings | None = None) -> EgressProxyServer:
    resolved = settings or EgressSettings.from_env()
    categories = []
    if resolved.allow_package_registries:
        categories.append(Category("package_registries", enabled=True))
    resolver = StaticPolicyResolver(
        {
            resolved.lease_id: EgressPolicy(
                categories=tuple(categories),
                router_host=resolved.router_host,
            )
        }
    )
    return EgressProxyServer(
        EgressProxy(
            resolver=resolver,
            audit=_audit_sink(resolved),
            byte_budget=resolved.byte_budget,
        ),
        default_lease_id=resolved.lease_id,
        default_tenant_id=resolved.tenant_id,
    )


def create_admin_app() -> FastAPI:
    configure_telemetry("egress-proxy")
    app = FastAPI(title="loopit-egress-admin")
    add_loopit_telemetry(app, "egress-proxy")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


def _audit_sink(settings: EgressSettings) -> AuditSink:
    if not settings.audit_dsn:
        return StoreAuditSink(InMemoryAuditStore())
    return PostgresAppendOnlyAuditSink(connect(settings.audit_dsn))


def _audit_dsn_from_env() -> str:
    try:
        return require_secret(os.environ, "LOOPIT_AUDIT_DSN", min_length=1)
    except SecretConfigurationError:
        if _env_bool("LOOPIT_AUDIT_EPHEMERAL", False):
            return ""
        raise


def _parse_headers(raw: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in raw.split("\r\n"):
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
    return headers


async def _read_body(reader: asyncio.StreamReader, length: int) -> bytes:
    if length <= 0:
        return b""
    return await reader.readexactly(length)


def _target(method: str, target: str, headers: dict[str, str]) -> tuple[str, int, str]:
    if method.upper() == "CONNECT":
        host, _, port_s = target.partition(":")
        return host, int(port_s or "443"), f"https://{target}/"
    parts = urlsplit(target)
    if not parts.scheme or not parts.hostname:
        host_header = headers.get("host", "")
        host, _, port_s = host_header.partition(":")
        return host, int(port_s or "80"), f"http://{host_header}{target}"
    return parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), target


async def _resolve(host: str) -> tuple[str, ...]:
    if _is_ip(host):
        return (host,)
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, None, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
    return tuple({str(info[4][0]) for info in infos})


def _origin_form(target: str) -> str:
    parts = urlsplit(target)
    if not parts.scheme:
        return target
    path = parts.path or "/"
    return f"{path}?{parts.query}" if parts.query else path


def _strip_proxy_headers(headers: dict[str, str]) -> dict[str, str]:
    return {
        k: v
        for k, v in headers.items()
        if k
        not in {
            "proxy-authorization",
            "proxy-authenticate",
            "proxy-connection",
            "connection",
            "x-loopit-lease",
            "x-loopit-tenant",
        }
    }


def _validated_connect_host(resolved_ips: tuple[str, ...]) -> str:
    if not resolved_ips:
        raise OSError("host did not resolve")
    return sorted(resolved_ips)[0]


def _format_request(method: str, path: str, headers: dict[str, str], body: bytes) -> bytes:
    lines = [
        f"{method.upper()} {path} HTTP/1.1",
        *[f"{k}: {v}" for k, v in headers.items()],
        "",
        "",
    ]
    return "\r\n".join(lines).encode("latin1") + body


async def _tunnel(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    upstream_reader: asyncio.StreamReader,
    upstream_writer: asyncio.StreamWriter,
) -> None:
    await asyncio.gather(
        _copy(client_reader, upstream_writer), _copy(upstream_reader, client_writer)
    )


async def _copy(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()


def _is_ip(host: str) -> bool:
    try:
        socket.inet_pton(socket.AF_INET, host)
        return True
    except OSError:
        try:
            socket.inet_pton(socket.AF_INET6, host)
            return True
        except OSError:
            return False


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


async def amain() -> None:
    settings = EgressSettings.from_env()
    proxy = create_proxy(settings)
    proxy_task = asyncio.create_task(proxy.serve_forever(settings.host, settings.port))
    admin = uvicorn.Server(
        uvicorn.Config(
            create_admin_app(), host=settings.admin_host, port=settings.admin_port, log_level="info"
        )
    )
    admin_task = asyncio.create_task(admin.serve())
    try:
        await asyncio.gather(proxy_task, admin_task)
    finally:
        await proxy.stop()


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOOPIT_LOG_LEVEL", "INFO"), format="%(message)s")
    asyncio.run(amain())


if __name__ == "__main__":
    main()
