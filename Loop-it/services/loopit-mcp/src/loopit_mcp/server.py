"""HTTP surface: health plus MCP streamable HTTP at POST /mcp."""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, Request, Response
from loopit_telemetry import add_loopit_telemetry, configure_telemetry

from .client import LoopitApiClient
from .protocol import handle_rpc


@dataclass(frozen=True, slots=True)
class Settings:
    host: str = "0.0.0.0"  # noqa: S104 - container listener default.
    port: int = 8010
    api_base_url: str = "http://api:8000"

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            host=os.environ.get("LOOPIT_MCP_HOST", "0.0.0.0"),  # noqa: S104
            port=int(os.environ.get("PORT", os.environ.get("LOOPIT_MCP_PORT", "8010"))),
            api_base_url=os.environ.get("LOOPIT_API_BASE_URL", "http://api:8000"),
        )


def create_app(
    settings: Settings | None = None,
    *,
    client: LoopitApiClient | None = None,
) -> FastAPI:
    resolved = settings or Settings.from_env()
    configure_telemetry("loopit-mcp")
    app = FastAPI(title="loopit-mcp")
    add_loopit_telemetry(app, "loopit-mcp")
    app.state.settings = resolved
    app.state.client = client or LoopitApiClient(resolved.api_base_url)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, str]:
        return {"status": "ready"}

    @app.post("/mcp")
    async def mcp(
        request: Request,
        authorization: str | None = Header(default=None),
        mcp_session_id: str | None = Header(default=None, alias="Mcp-Session-Id"),
    ) -> Response:
        try:
            payload: Any = await request.json()
        except Exception:
            body = _json_bytes(
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
            )
            return Response(content=body, media_type="application/json", status_code=400)
        token = ""
        if authorization and authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
        result = handle_rpc(payload, client=app.state.client, token=token)
        session = mcp_session_id or secrets.token_hex(16)
        headers = {"Mcp-Session-Id": session}
        if result is None:
            return Response(status_code=202, headers=headers)
        return Response(content=_json_bytes(result), media_type="application/json", headers=headers)

    return app


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload).encode()


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        factory=False,
    )


if __name__ == "__main__":
    main()
