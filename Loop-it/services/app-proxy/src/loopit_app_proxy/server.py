"""Streaming HTTP and WebSocket listener for deployed public apps."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Protocol

import anyio
import httpx2
import uvicorn
import websockets
from fastapi import FastAPI, Request, Response, WebSocket
from loopit_agent_core.audit import AuditEvent, AuditSink
from loopit_agent_core.config import SecretConfigurationError, require_secret
from loopit_store import AuditStore, InMemoryAuditStore, PostgresAppendOnlyAuditSink
from loopit_store.postgres import connect
from loopit_telemetry import add_loopit_telemetry, configure_telemetry
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.client import ClientConnection

from .billing import (
    BufferedHostingBillingReporter,
    HostingBillingReporter,
    NoopHostingBillingReporter,
)
from .limits import PerHostRateLimiter, RateLimitSettings
from .proxy import AppProxy, AppRequest, normalise_host, origin_matches_host, refuse
from .routes import (
    Backend,
    DomainsRouteCacheSettings,
    DomainsRouteResolver,
    backends_from_json,
    hostnames_from_json,
)

LOG = logging.getLogger("loopit.app_proxy")

HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


@dataclass(frozen=True, slots=True)
class AppProxySettings:
    host: str = "0.0.0.0"  # noqa: S104 - this service is intentionally a public edge.
    port: int = 8009
    hostnames_json: str = "[]"
    backends_json: str = "[]"
    domains_url: str = ""
    service_token: str = ""
    route_positive_ttl_seconds: float = 3.0
    route_negative_ttl_seconds: float = 1.0
    route_lookup_timeout_seconds: float = 1.5
    audit_dsn: str = ""
    max_request_bytes: int = 10 * 1024 * 1024
    request_body_timeout_seconds: float = 10.0
    upstream_timeout_seconds: float = 30.0
    websocket_open_timeout_seconds: float = 10.0
    websocket_idle_timeout_seconds: float = 60.0
    rate_limit_per_minute: int = 600
    billing_url: str = ""
    hosting_egress_flush_bytes: int = 1_000_000
    hosting_egress_flush_interval_seconds: float = 5.0
    hosting_quota_refusal_ttl_seconds: float = 60.0

    @classmethod
    def from_env(cls) -> AppProxySettings:
        return cls(
            host=os.environ.get("LOOPIT_APP_PROXY_HOST", "0.0.0.0"),  # noqa: S104
            port=int(os.environ.get("LOOPIT_APP_PROXY_PORT", os.environ.get("PORT", "8009"))),
            hostnames_json=os.environ.get("LOOPIT_APP_PROXY_HOSTNAMES", "[]"),
            backends_json=os.environ.get("LOOPIT_APP_PROXY_BACKENDS", "[]"),
            domains_url=os.environ.get("LOOPIT_DOMAINS_URL", ""),
            service_token=_service_token_from_env(
                os.environ.get("LOOPIT_DOMAINS_URL", ""), os.environ.get("LOOPIT_BILLING_URL", "")
            ),
            route_positive_ttl_seconds=float(
                os.environ.get("LOOPIT_APP_PROXY_ROUTE_POSITIVE_TTL_SECONDS", "3")
            ),
            route_negative_ttl_seconds=float(
                os.environ.get("LOOPIT_APP_PROXY_ROUTE_NEGATIVE_TTL_SECONDS", "1")
            ),
            route_lookup_timeout_seconds=float(
                os.environ.get("LOOPIT_APP_PROXY_ROUTE_LOOKUP_TIMEOUT_SECONDS", "1.5")
            ),
            audit_dsn=_audit_dsn_from_env(),
            max_request_bytes=int(os.environ.get("LOOPIT_APP_PROXY_MAX_REQUEST_BYTES", "10485760")),
            request_body_timeout_seconds=float(
                os.environ.get("LOOPIT_APP_PROXY_REQUEST_BODY_TIMEOUT_SECONDS", "10")
            ),
            upstream_timeout_seconds=float(
                os.environ.get("LOOPIT_APP_PROXY_UPSTREAM_TIMEOUT_SECONDS", "30")
            ),
            websocket_open_timeout_seconds=float(
                os.environ.get("LOOPIT_APP_PROXY_WEBSOCKET_OPEN_TIMEOUT_SECONDS", "10")
            ),
            websocket_idle_timeout_seconds=float(
                os.environ.get("LOOPIT_APP_PROXY_WEBSOCKET_IDLE_TIMEOUT_SECONDS", "60")
            ),
            rate_limit_per_minute=int(
                os.environ.get("LOOPIT_APP_PROXY_RATE_LIMIT_PER_MINUTE", "600")
            ),
            billing_url=os.environ.get("LOOPIT_BILLING_URL", ""),
            hosting_egress_flush_bytes=int(
                os.environ.get("LOOPIT_APP_PROXY_HOSTING_EGRESS_FLUSH_BYTES", "1000000")
            ),
            hosting_egress_flush_interval_seconds=float(
                os.environ.get("LOOPIT_APP_PROXY_HOSTING_EGRESS_FLUSH_INTERVAL_SECONDS", "5")
            ),
            hosting_quota_refusal_ttl_seconds=float(
                os.environ.get("LOOPIT_APP_PROXY_HOSTING_QUOTA_REFUSAL_TTL_SECONDS", "60")
            ),
        )


class StoreAuditSink:
    def __init__(self, store: AuditStore) -> None:
        self._store = store

    def emit(self, event: AuditEvent) -> None:
        self._store.append(event)


class WebSocketDialer(Protocol):
    async def connect(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        open_timeout: float,
    ) -> ClientConnection:
        """Open a WebSocket connection to the backend."""


class DefaultWebSocketDialer:
    async def connect(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        open_timeout: float,
    ) -> ClientConnection:
        return await websockets.connect(
            url,
            additional_headers=dict(headers),
            open_timeout=open_timeout,
        )


def create_app(
    *,
    proxy: AppProxy | None = None,
    settings: AppProxySettings | None = None,
    client: httpx2.AsyncClient | None = None,
    websocket_dialer: WebSocketDialer | None = None,
    rate_limiter: PerHostRateLimiter | None = None,
    billing: HostingBillingReporter | None = None,
) -> FastAPI:
    resolved = settings or AppProxySettings.from_env()
    setup_json_logging()
    configure_telemetry("app-proxy")

    timeout = httpx2.Timeout(resolved.upstream_timeout_seconds)

    domains_resolver = _domains_resolver(resolved)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.http = client or httpx2.AsyncClient(follow_redirects=False, timeout=timeout)
        try:
            yield
        finally:
            if client is None:
                await app.state.http.aclose()
            if domains_resolver is not None:
                await domains_resolver.aclose()
            await app.state.hosting_billing.aclose()

    app = FastAPI(title="loopit-app-proxy", lifespan=lifespan)
    add_loopit_telemetry(app, "app-proxy")
    if client is not None:
        app.state.http = client
    app.state.websocket_dialer = websocket_dialer or DefaultWebSocketDialer()
    app.state.rate_limiter = rate_limiter or PerHostRateLimiter(
        RateLimitSettings(requests_per_window=resolved.rate_limit_per_minute)
    )
    app.state.hosting_billing = billing or _billing_reporter(resolved)
    app.state.proxy = proxy or AppProxy(
        hostnames=domains_resolver or hostnames_from_json(resolved.hostnames_json),
        backends=backends_from_json(resolved.backends_json),
        audit=_audit_sink(resolved),
    )

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.websocket("/{path:path}")
    async def websocket_proxy(path: str, websocket: WebSocket) -> None:
        host = normalise_host(websocket.headers.get("host", ""))
        if not _rate_limit(websocket.app, host):
            await websocket.close(code=1008, reason="rate limited")
            return
        if not origin_matches_host(websocket.headers.get("origin"), host):
            await websocket.close(code=1008, reason="origin mismatch")
            websocket.app.state.proxy._emit(
                _websocket_request(path, websocket), refuse("origin_mismatch")
            )
            return
        inbound = _websocket_request(path, websocket)
        decision = await websocket.app.state.proxy.handle(inbound)
        if not decision.allowed or decision.backend is None:
            await websocket.close(code=1008, reason="not found")
            return
        await websocket.accept()
        backend_url = _backend_ws_url(decision.backend, inbound.path)
        outgoing_headers = _outgoing_headers(decision.forward_headers)
        try:
            upstream = await websocket.app.state.websocket_dialer.connect(
                backend_url,
                headers=outgoing_headers,
                open_timeout=resolved.websocket_open_timeout_seconds,
            )
        except websockets.WebSocketException:
            await websocket.close(code=1011, reason="bad gateway")
            return
        try:
            await _relay_websocket(
                websocket,
                upstream,
                idle_timeout=resolved.websocket_idle_timeout_seconds,
                host=host,
                tenant_id=decision.tenant_id or "",
                project_id=decision.project_id or "",
                billing=websocket.app.state.hosting_billing,
            )
        finally:
            await upstream.close()

    @app.api_route(
        "/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    )
    async def reverse_proxy(path: str, request: Request) -> Response:
        host = normalise_host(request.headers.get("host", ""))
        if not _rate_limit(request.app, host):
            decision = refuse("rate_limited")
            return Response(
                "rate limited", status_code=decision.status, headers=decision.response_headers
            )

        inbound = AppRequest(
            host=host,
            path="/" + path + (f"?{request.url.query}" if request.url.query else ""),
            method=request.method,
            headers={k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP},
            client_ip=request.client.host if request.client else None,
            scheme=request.url.scheme,
        )
        decision = await request.app.state.proxy.handle(inbound)
        if not decision.allowed or decision.backend is None:
            refusal_body = "quota exceeded" if decision.reason == "quota_exceeded" else "not found"
            return Response(
                refusal_body, status_code=decision.status, headers=decision.response_headers
            )
        billing_refusal = request.app.state.hosting_billing.quota_refusal(host)
        if billing_refusal is not None:
            return Response(
                _quota_body(billing_refusal),
                status_code=402,
                headers=decision.response_headers | {"Content-Type": "text/plain; charset=utf-8"},
            )

        try:
            body = await _read_limited_body(
                request,
                max_bytes=resolved.max_request_bytes,
                timeout_seconds=resolved.request_body_timeout_seconds,
            )
        except RequestTooLarge:
            denied = refuse("too_large")
            return Response("too large", status_code=denied.status, headers=denied.response_headers)
        except TimeoutError:
            return Response(
                "request timeout",
                status_code=408,
                headers=decision.response_headers,
            )

        upstream_url = _backend_url(decision.backend, inbound.path)
        upstream_request = request.app.state.http.build_request(
            request.method,
            upstream_url,
            headers=_outgoing_headers(decision.forward_headers),
            content=body,
        )
        try:
            upstream = await request.app.state.http.send(upstream_request, stream=True)
        except httpx2.TimeoutException:
            return Response("gateway timeout", status_code=504, headers=decision.response_headers)
        except httpx2.TransportError:
            return Response("bad gateway", status_code=502, headers=decision.response_headers)
        headers = _response_headers(upstream.headers)
        return StreamingResponse(
            _metered_response_bytes(
                upstream.aiter_bytes(),
                billing=request.app.state.hosting_billing,
                host=host,
                tenant_id=decision.tenant_id or "",
                project_id=decision.project_id or "",
            ),
            status_code=upstream.status_code,
            headers=headers,
            background=BackgroundTask(upstream.aclose),
        )

    return app


class RequestTooLarge(Exception):
    """Inbound request body exceeded the configured edge limit."""


async def _read_limited_body(
    request: Request,
    *,
    max_bytes: int,
    timeout_seconds: float,
) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async with asyncio.timeout(timeout_seconds):
        async for chunk in request.stream():
            total += len(chunk)
            if total > max_bytes:
                raise RequestTooLarge
            chunks.append(chunk)
    return b"".join(chunks)


async def _relay_websocket(
    downstream: WebSocket,
    upstream: ClientConnection,
    *,
    idle_timeout: float,
    host: str,
    tenant_id: str,
    project_id: str,
    billing: HostingBillingReporter,
) -> None:
    async def client_to_backend() -> None:
        try:
            while True:
                message = await downstream.receive()
                if message["type"] == "websocket.disconnect":
                    return
                text = message.get("text")
                if text is not None:
                    await upstream.send(text)
                    continue
                data = message.get("bytes")
                if data is not None:
                    await upstream.send(data)
        except WebSocketDisconnect:
            return
        finally:
            task_group.cancel_scope.cancel()

    async def backend_to_client() -> None:
        try:
            while True:
                with anyio.fail_after(idle_timeout):
                    message = await upstream.recv()
                if isinstance(message, str):
                    await downstream.send_text(message)
                    byte_count = len(message.encode())
                else:
                    await downstream.send_bytes(message)
                    byte_count = len(message)
                await billing.report_egress(
                    host=host,
                    tenant_id=tenant_id,
                    project_id=project_id,
                    byte_count=byte_count,
                )
        finally:
            task_group.cancel_scope.cancel()

    async with anyio.create_task_group() as task_group:
        task_group.start_soon(client_to_backend)
        task_group.start_soon(backend_to_client)


async def _metered_response_bytes(
    chunks: AsyncIterator[bytes],
    *,
    billing: HostingBillingReporter,
    host: str,
    tenant_id: str,
    project_id: str,
) -> AsyncIterator[bytes]:
    total = 0
    async for chunk in chunks:
        total += len(chunk)
        yield chunk
    await billing.report_egress(
        host=host,
        tenant_id=tenant_id,
        project_id=project_id,
        byte_count=total,
    )


def _quota_body(reason: str) -> str:
    return f"This app is over its hosting limit ({reason}). Upgrade to keep it live."


def _websocket_request(path: str, websocket: WebSocket) -> AppRequest:
    return AppRequest(
        host=websocket.headers.get("host", ""),
        path="/" + path + (f"?{websocket.url.query}" if websocket.url.query else ""),
        method="WEBSOCKET",
        headers={k: v for k, v in websocket.headers.items() if k.lower() not in HOP_BY_HOP},
        client_ip=websocket.client.host if websocket.client else None,
        scheme="wss" if websocket.url.scheme == "wss" else "ws",
    )


def _rate_limit(app: FastAPI, host: str) -> bool:
    return bool(app.state.rate_limiter.allow(host, now=time.time()))


def _audit_sink(settings: AppProxySettings) -> AuditSink:
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


def _service_token_from_env(domains_url: str, billing_url: str) -> str:
    if not domains_url and not billing_url:
        return ""
    return require_secret(os.environ, "LOOPIT_SERVICE_TOKEN")


def _domains_resolver(settings: AppProxySettings) -> DomainsRouteResolver | None:
    if not settings.domains_url:
        return None
    if not settings.service_token:
        raise RuntimeError("domains route resolver requires LOOPIT_SERVICE_TOKEN")
    return DomainsRouteResolver(
        base_url=settings.domains_url,
        service_token=settings.service_token,
        cache=DomainsRouteCacheSettings(
            positive_ttl_seconds=settings.route_positive_ttl_seconds,
            negative_ttl_seconds=settings.route_negative_ttl_seconds,
            timeout_seconds=settings.route_lookup_timeout_seconds,
        ),
    )


def _billing_reporter(settings: AppProxySettings) -> HostingBillingReporter:
    if not settings.billing_url:
        return NoopHostingBillingReporter()
    if not settings.service_token:
        raise RuntimeError("hosting billing reporter requires LOOPIT_SERVICE_TOKEN")
    return BufferedHostingBillingReporter(
        billing_url=settings.billing_url,
        service_token=settings.service_token,
        flush_bytes=settings.hosting_egress_flush_bytes,
        flush_interval_seconds=settings.hosting_egress_flush_interval_seconds,
        refusal_ttl_seconds=settings.hosting_quota_refusal_ttl_seconds,
    )


def _backend_url(backend: Backend, path: str) -> str:
    return f"http://{backend.host}:{backend.port}{path}"


def _backend_ws_url(backend: Backend, path: str) -> str:
    return f"ws://{backend.host}:{backend.port}{path}"


def _outgoing_headers(headers: Mapping[str, str]) -> dict[str, str]:
    return {
        key: value
        for key, value in headers.items()
        if key.lower() not in HOP_BY_HOP and key.lower() != "host"
    }


def _response_headers(upstream_headers: Mapping[str, str]) -> dict[str, str]:
    return {k: v for k, v in upstream_headers.items() if k.lower() not in HOP_BY_HOP}


def setup_json_logging() -> None:
    logging.basicConfig(level=os.environ.get("LOOPIT_LOG_LEVEL", "INFO"), format="%(message)s")


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def main() -> None:
    settings = AppProxySettings.from_env()
    uvicorn.run(
        create_app(settings=settings),
        host=settings.host,
        port=settings.port,
        timeout_keep_alive=5,
    )


if __name__ == "__main__":
    main()
