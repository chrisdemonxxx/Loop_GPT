"""Streaming HTTP listener for authenticated previews (incl. HMR websockets)."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx2
import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from loopit_agent_core.audit import AuditEvent, AuditSink
from loopit_agent_core.config import SecretConfigurationError, require_secret
from loopit_store import AuditStore, InMemoryAuditStore, PostgresAppendOnlyAuditSink
from loopit_store.postgres import connect
from loopit_telemetry import add_loopit_telemetry, configure_telemetry
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse
from starlette.websockets import WebSocketState

from .bridge import inject_preview_bridges
from .proxy import SECURITY_HEADERS, PreviewProxy, PreviewRequest
from .routes import Backend, Route, RouteTable
from .tokens import TokenSigner

LOG = logging.getLogger("loopit.preview")
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

#: Path-based preview: ``/p/{project_id}/...`` → strip prefix before upstream.
_PATH_PROJECT = re.compile(r"^/p/(?P<project>[A-Za-z0-9_-]{1,64})(?P<rest>/.*)?$")


@dataclass(frozen=True, slots=True)
class PreviewSettings:
    host: str = "0.0.0.0"  # noqa: S104 - public edge listener default.
    port: int = 8080
    signing_key: str = ""
    preview_domain: str = ".preview.loopit.dev"
    routes_json: str = "[]"
    audit_dsn: str = ""
    service_token: str = ""
    frame_ancestors: str = "'self'"

    @classmethod
    def from_env(cls) -> PreviewSettings:
        return cls(
            host=os.environ.get("LOOPIT_PREVIEW_HOST", "0.0.0.0"),  # noqa: S104
            port=int(os.environ.get("LOOPIT_PREVIEW_PORT", "8080")),
            signing_key=require_secret(os.environ, "LOOPIT_PREVIEW_SIGNING_KEY"),
            preview_domain=os.environ.get("LOOPIT_PREVIEW_DOMAIN", ".preview.loopit.dev"),
            routes_json=os.environ.get("LOOPIT_PREVIEW_ROUTES", "[]"),
            audit_dsn=_audit_dsn_from_env(),
            service_token=os.environ.get("LOOPIT_SERVICE_TOKEN", ""),
            frame_ancestors=os.environ.get("LOOPIT_PREVIEW_FRAME_ANCESTORS", "'self'"),
        )


class StoreAuditSink:
    def __init__(self, store: AuditStore) -> None:
        self._store = store

    def emit(self, event: AuditEvent) -> None:
        self._store.append(event)


def create_app(
    *,
    proxy: PreviewProxy | None = None,
    settings: PreviewSettings | None = None,
    client: httpx2.AsyncClient | None = None,
) -> FastAPI:
    resolved = settings or PreviewSettings.from_env()
    setup_json_logging()
    configure_telemetry("preview-proxy")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.http = client or httpx2.AsyncClient(follow_redirects=False)
        try:
            yield
        finally:
            if client is None:
                await app.state.http.aclose()

    app = FastAPI(title="loopit-preview", lifespan=lifespan)
    add_loopit_telemetry(app, "preview-proxy")
    if client is not None:
        app.state.http = client
    routes = _routes_from_json(resolved.routes_json)
    app.state.routes_table = routes
    app.state.settings = resolved
    security_headers = dict(SECURITY_HEADERS)
    security_headers["Content-Security-Policy"] = (
        f"frame-ancestors {resolved.frame_ancestors}; base-uri 'none'; form-action 'self'"
    )
    if resolved.frame_ancestors.strip() not in {"'self'", "none"}:
        security_headers.pop("X-Frame-Options", None)
    app.state.security_headers = security_headers
    app.state.proxy = proxy or PreviewProxy(
        signer=TokenSigner(resolved.signing_key.encode()),
        routes=routes,
        audit=_audit_sink(resolved),
        preview_domain=resolved.preview_domain,
    )

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    # --- Dynamic route bind (Phase 1.4) ---------------------------------------

    @app.post("/internal/routes")
    async def bind_route(request: Request) -> dict[str, Any]:
        _require_service(request, resolved.service_token)
        body = await request.json()
        route = Route(
            preview_host=str(body["preview_host"]),
            project_id=str(body["project_id"]),
            tenant_id=str(body["tenant_id"]),
            lease_id=str(body["lease_id"]),
            backend=Backend(str(body["backend_host"]), int(body["backend_port"])),
        )
        app.state.routes_table.bind(route)
        return {
            "preview_host": route.preview_host,
            "project_id": route.project_id,
            "lease_id": route.lease_id,
        }

    @app.delete("/internal/routes/{preview_host}")
    def unbind_route(preview_host: str, request: Request) -> dict[str, str]:
        _require_service(request, resolved.service_token)
        app.state.routes_table.unbind(preview_host)
        return {"status": "ok"}

    @app.get("/internal/routes")
    def list_routes(request: Request) -> dict[str, Any]:
        _require_service(request, resolved.service_token)
        return {
            "routes": [
                {
                    "preview_host": r.preview_host,
                    "project_id": r.project_id,
                    "tenant_id": r.tenant_id,
                    "lease_id": r.lease_id,
                    "backend_host": r.backend.host,
                    "backend_port": r.backend.port,
                }
                for r in app.state.routes_table.list_routes()
            ]
        }

    @app.websocket("/{path:path}")
    async def websocket_proxy(websocket: WebSocket, path: str) -> None:
        """Proxy Vite HMR (and similar) websockets to the sandbox backend."""
        token = websocket.query_params.get("token") or websocket.query_params.get("preview_token")
        if not token:
            auth = websocket.headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                token = auth[7:].strip()
        host = (websocket.headers.get("host") or "").split(":", 1)[0]
        full_path = "/" + path + (f"?{websocket.url.query}" if websocket.url.query else "")
        path_project, upstream_path = _split_path_project(full_path)
        inbound = PreviewRequest(
            host=host,
            path=upstream_path,
            method="GET",
            token=token,
            headers={k: v for k, v in websocket.headers.items() if k.lower() not in HOP_BY_HOP},
            client_ip=websocket.client.host if websocket.client else None,
        )
        decision = app.state.proxy.handle(
            inbound, now=time.time(), path_project_id=path_project
        )
        if not decision.allowed or decision.backend is None:
            await websocket.close(code=1008, reason="preview not authorised")
            return

        await websocket.accept()
        backend_url = f"ws://{decision.backend.host}:{decision.backend.port}{upstream_path}"
        try:
            import asyncio

            import websockets  # type: ignore[import-untyped]
        except ImportError:
            await websocket.close(code=1011, reason="websocket proxy unavailable")
            return

        try:
            async with websockets.connect(
                backend_url,
                additional_headers={
                    k: v
                    for k, v in decision.forward_headers.items()
                    if k.lower() not in HOP_BY_HOP and k.lower() != "host"
                },
            ) as upstream:

                async def client_to_upstream() -> None:
                    try:
                        while True:
                            message = await websocket.receive()
                            if message["type"] == "websocket.disconnect":
                                break
                            if "text" in message and message["text"] is not None:
                                await upstream.send(message["text"])
                            elif "bytes" in message and message["bytes"] is not None:
                                await upstream.send(message["bytes"])
                    except WebSocketDisconnect:
                        pass

                async def upstream_to_client() -> None:
                    try:
                        async for message in upstream:
                            if websocket.client_state != WebSocketState.CONNECTED:
                                break
                            if isinstance(message, bytes):
                                await websocket.send_bytes(message)
                            else:
                                await websocket.send_text(str(message))
                    except Exception:
                        pass

                await asyncio.gather(client_to_upstream(), upstream_to_client())
        except Exception:
            LOG.exception("websocket proxy failed")
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close(code=1011, reason="upstream websocket failed")

    @app.api_route(
        "/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    )
    async def reverse_proxy(path: str, request: Request) -> Response:
        token = _token_from(request)
        host = request.headers.get("host", "")
        full_path = "/" + path + (f"?{request.url.query}" if request.url.query else "")
        path_project, upstream_path = _split_path_project(full_path)
        inbound = PreviewRequest(
            host=host.split(":", 1)[0],
            path=upstream_path,
            method=request.method,
            token=token,
            headers={k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP},
            client_ip=request.client.host if request.client else None,
        )
        decision = request.app.state.proxy.handle(
            inbound, now=time.time(), path_project_id=path_project
        )
        if not decision.allowed or decision.backend is None:
            return Response(
                "not found",
                status_code=decision.status,
                headers=request.app.state.security_headers,
            )

        upstream_url = _backend_url(decision.backend, upstream_path)
        outgoing_headers = {
            key: value
            for key, value in decision.forward_headers.items()
            if key.lower() not in HOP_BY_HOP and key.lower() != "host"
        }
        upstream_request = request.app.state.http.build_request(
            request.method,
            upstream_url,
            headers=outgoing_headers,
            content=await request.body(),
        )
        upstream = await request.app.state.http.send(upstream_request, stream=True)
        headers = _response_headers(upstream.headers, request.app.state.security_headers)
        content_type = headers.get("content-type", headers.get("Content-Type", ""))
        if "text/html" in content_type.lower() and request.method == "GET":
            body = b"".join([chunk async for chunk in upstream.aiter_bytes()])
            await upstream.aclose()
            body = inject_preview_bridges(body)
            headers.pop("content-length", None)
            headers.pop("Content-Length", None)
            return Response(content=body, status_code=upstream.status_code, headers=headers)

        return StreamingResponse(
            upstream.aiter_bytes(),
            status_code=upstream.status_code,
            headers=headers,
            background=BackgroundTask(upstream.aclose),
        )

    return app


def _split_path_project(full_path: str) -> tuple[str | None, str]:
    """Return (project_id|None, path to forward upstream)."""
    match = _PATH_PROJECT.match(full_path.split("?", 1)[0])
    if not match:
        return None, full_path
    rest = match.group("rest") or "/"
    query = ""
    if "?" in full_path:
        query = "?" + full_path.split("?", 1)[1]
    return match.group("project"), rest + query


def _require_service(request: Request, expected: str) -> None:
    if not expected:
        from fastapi import HTTPException

        raise HTTPException(status_code=503, detail="service token not configured")
    got = request.headers.get("x-loopit-service-token", "")
    if got != expected:
        from fastapi import HTTPException

        raise HTTPException(status_code=401, detail="unauthorized")


def _routes_from_json(raw: str) -> RouteTable:
    routes = RouteTable()
    for item in json.loads(raw):
        if not isinstance(item, Mapping):
            continue
        routes.bind(
            Route(
                preview_host=str(item["preview_host"]),
                project_id=str(item["project_id"]),
                tenant_id=str(item["tenant_id"]),
                lease_id=str(item["lease_id"]),
                backend=Backend(str(item["backend_host"]), int(item["backend_port"])),
            )
        )
    return routes


def _audit_sink(settings: PreviewSettings) -> AuditSink:
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


def _token_from(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    token = request.query_params.get("token")
    token = token or request.query_params.get("preview_token")
    return token if token else None


def _backend_url(backend: Backend, path: str) -> str:
    return f"http://{backend.host}:{backend.port}{path}"


def _response_headers(
    upstream_headers: Mapping[str, str], security_headers: Mapping[str, str]
) -> dict[str, str]:
    headers = {k: v for k, v in upstream_headers.items() if k.lower() not in HOP_BY_HOP}
    headers.update(SECURITY_HEADERS)
    headers.update(security_headers)
    return headers


def setup_json_logging() -> None:
    logging.basicConfig(level=os.environ.get("LOOPIT_LOG_LEVEL", "INFO"), format="%(message)s")


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


app = create_app()


def main() -> None:
    settings = PreviewSettings.from_env()
    uvicorn.run(create_app(settings=settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
