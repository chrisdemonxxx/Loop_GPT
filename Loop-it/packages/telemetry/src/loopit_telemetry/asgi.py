from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from opentelemetry import propagate, trace
from opentelemetry.trace import SpanKind
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from .attributes import scrub_attributes
from .metrics import get_metrics

Handler = Callable[[Request], Awaitable[Response]]


class LoopItTelemetryMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, *, service_name: str) -> None:
        super().__init__(app)
        self._service_name = service_name
        self._metrics = get_metrics(f"loopit.{service_name}")

    async def dispatch(self, request: Request, call_next: Handler) -> Response:
        route = request.url.path
        method = request.method
        correlation_id = request.headers.get("x-correlation-id") or f"corr_{uuid.uuid4().hex}"
        context = propagate.extract(dict(request.headers))
        tracer = trace.get_tracer(f"loopit.{self._service_name}")
        started = time.perf_counter()
        status_code = 500
        with tracer.start_as_current_span(
            f"{method} {route}",
            context=context,
            kind=SpanKind.SERVER,
            attributes=scrub_attributes(
                {
                    "http.request.method": method,
                    "url.path": route,
                    "loopit.correlation_id": correlation_id,
                    "loopit.run_id": request.headers.get("x-loopit-run-id", ""),
                    "loopit.project_id": request.headers.get("x-loopit-project-id", ""),
                    "loopit.tenant_id": request.headers.get("x-loopit-tenant", ""),
                }
            ),
        ) as span:
            try:
                response = await call_next(request)
                status_code = response.status_code
                return response
            except Exception as exc:
                span.record_exception(exc)
                raise
            finally:
                duration_ms = (time.perf_counter() - started) * 1000
                span.set_attribute("http.response.status_code", status_code)
                span.set_attribute("loopit.duration_ms", duration_ms)
                self._metrics.record_request(
                    service=self._service_name,
                    route=route,
                    method=method,
                    status_code=status_code,
                    duration_ms=duration_ms,
                )
                if "response" in locals():
                    response.headers["x-correlation-id"] = correlation_id
                    trace_id = span.get_span_context().trace_id
                    if trace_id:
                        response.headers["x-loopit-trace-id"] = f"{trace_id:032x}"


def add_loopit_telemetry(app: Any, service_name: str) -> None:
    app.add_middleware(LoopItTelemetryMiddleware, service_name=service_name)
