"""HTTP surface for the sandbox model router."""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import logging
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from loopit_agent_core.audit import AuditEvent, AuditSink, InMemoryAuditSink
from loopit_agent_core.config import SecretConfigurationError, require_secret
from loopit_auth import Actor, IdentityTokenError, Resource, TokenSigner, authorize
from loopit_store import AuditStore, InMemoryAuditStore, PostgresAuditStore
from loopit_store.postgres import connect
from loopit_telemetry import add_loopit_telemetry, configure_telemetry

from .client import max_output_tokens_from_env
from .errors import UpstreamError
from .openai_upstream import OpenAICompatibleUpstream, UpstreamEndpoint
from .quota import QuotaExceeded, QuotaLedger, TenantQuota
from .router import ModelRouter
from .routing import (
    DIFFICULTIES,
    Difficulty,
    InMemoryModelSelectionStore,
    ModelCatalog,
    RoutingError,
    RoutingPolicy,
    SelectionScope,
    default_policy,
    huggingface_router_policy,
    huggingface_unrestricted_policy,
)
from .upstream import StaticSecretResolver, UpstreamResult

LOG = logging.getLogger("loopit.router")


@dataclass(frozen=True, slots=True)
class RouterSettings:
    host: str = "0.0.0.0"  # noqa: S104 - service listener default, admin can override.
    port: int = 8080
    lease_token_secret: str = ""
    upstream_base_url: str = "http://127.0.0.1:8001"
    upstream_bill_to: str | None = None
    model_api_key: str = ""
    default_credit_limit: float = 100.0
    store_dsn: str = ""
    identity_secret: str = ""
    identity_issuer: str = "loopit-gateway"
    identity_audience: str = "loopit-control-plane"
    identity_kid: str = "local-1"

    @classmethod
    def from_env(cls) -> RouterSettings:
        return cls(
            host=os.environ.get("LOOPIT_ROUTER_HOST", "0.0.0.0"),  # noqa: S104
            port=_env_int("LOOPIT_ROUTER_PORT", 8080),
            lease_token_secret=require_secret(os.environ, "LOOPIT_LEASE_TOKEN_SECRET"),
            upstream_base_url=os.environ.get(
                "LOOPIT_MODEL_UPSTREAM_BASE_URL", "http://127.0.0.1:8001"
            ),
            # X-HF-Bill-To: charge an organisation instead of the token's
            # personal account, which is where included-credit depletion hits.
            upstream_bill_to=os.environ.get("HF_BILL_TO") or None,
            model_api_key=require_secret(os.environ, "LOOPIT_MODEL_API_KEY"),
            default_credit_limit=_env_float("LOOPIT_ROUTER_DEFAULT_CREDIT_LIMIT", 100.0),
            store_dsn=os.environ.get("LOOPIT_STORE_DSN", ""),
            identity_secret=require_secret(os.environ, "LOOPIT_IDENTITY_SECRET"),
            identity_issuer=os.environ.get("LOOPIT_IDENTITY_ISSUER", "loopit-gateway"),
            identity_audience=os.environ.get("LOOPIT_IDENTITY_AUDIENCE", "loopit-control-plane"),
            identity_kid=os.environ.get("LOOPIT_IDENTITY_KID", "local-1"),
        )


@dataclass(frozen=True, slots=True)
class LeaseClaims:
    tenant_id: str
    lease_id: str
    run_id: str | None
    project_id: str | None
    expires_at: float


class StoreAuditSink:
    def __init__(self, store: AuditStore) -> None:
        self._store = store

    def emit(self, event: AuditEvent) -> None:
        self._store.append(event)


def create_app(
    *,
    router: ModelRouter | None = None,
    settings: RouterSettings | None = None,
    audit: AuditSink | None = None,
) -> FastAPI:
    resolved = settings or RouterSettings.from_env()
    setup_json_logging()
    configure_telemetry("router-svc")
    app = FastAPI(title="loopit-router")
    add_loopit_telemetry(app, "router-svc")

    ledger = QuotaLedger()
    app.state.ledger = ledger
    app.state.settings = resolved
    app.state.audit = audit or _audit_sink(resolved)
    app.state.selection_store = InMemoryModelSelectionStore()
    app.state.router = router or _build_router(
        resolved, ledger, app.state.audit, app.state.selection_store
    )
    app.state.catalog = app.state.router.policy.catalog
    app.state.identity_signer = TokenSigner(
        issuer=resolved.identity_issuer,
        audience=resolved.identity_audience,
        keys={resolved.identity_kid: resolved.identity_secret.encode()},
        current_kid=resolved.identity_kid,
    )

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, str]:
        return {"status": "ready"}

    @app.post("/v1/chat/completions")
    async def chat_completions(
        request: Request,
        claims: LeaseClaims = Depends(_require_lease_claims),  # noqa: B008
        x_loopit_difficulty: str | None = Header(default=None),
    ) -> dict[str, Any]:
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="request body must be a JSON object")
        if _contains_client_key(body, request.headers):
            raise HTTPException(
                status_code=400,
                detail="client-supplied upstreams, headers, or API keys are never accepted",
            )
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise HTTPException(status_code=400, detail="messages must be an array")

        _ensure_quota(ledger, claims.tenant_id, resolved.default_credit_limit)
        difficulty = _difficulty(
            str(x_loopit_difficulty or body.get("difficulty") or "implementation")
        )
        try:
            # complete() is synchronous urllib. Running it on the event loop
            # stalls /healthz for the full upstream timeout (minutes), which
            # Docker then marks unhealthy and the console reads as a hang.
            result = await asyncio.to_thread(
                app.state.router.complete,
                tenant_id=claims.tenant_id,
                difficulty=difficulty,
                messages=_messages(messages),
                response_schema=_response_schema(body),
                max_output_tokens=_max_tokens(body),
                run_id=claims.run_id,
                project_id=claims.project_id,
                trace_id=request.headers.get("x-loopit-trace-id"),
            )
        except QuotaExceeded as exc:
            raise HTTPException(status_code=429, detail="quota exceeded") from exc
        except UpstreamError as exc:
            LOG.warning(
                "upstream unavailable tenant=%s run=%s difficulty=%s: %s",
                claims.tenant_id,
                claims.run_id,
                difficulty,
                exc,
            )
            raise HTTPException(status_code=502, detail="upstream unavailable") from exc

        return _openai_response(result)

    @app.get("/v1/models/catalog")
    def model_catalog(
        org_id: str,
        request: Request,
        actor: Actor = Depends(_require_actor),  # noqa: B008
    ) -> dict[str, object]:
        _require_rbac(actor, "org:read", Resource(org_id=org_id))
        catalog: ModelCatalog = request.app.state.catalog
        return {"models": catalog.public_models()}

    @app.get("/v1/model-selection")
    def get_model_selection(
        org_id: str,
        request: Request,
        project_id: str | None = None,
        actor: Actor = Depends(_require_actor),  # noqa: B008
    ) -> dict[str, object]:
        _require_rbac(actor, "project:read", Resource(org_id=org_id, project_id=project_id))
        store: InMemoryModelSelectionStore = request.app.state.selection_store
        router_state: ModelRouter = request.app.state.router
        policy = store.resolve(SelectionScope(org_id, project_id), router_state.policy)
        return {"org_id": org_id, "project_id": project_id, "routes": policy.to_selection_dict()}

    @app.put("/v1/model-selection")
    async def put_model_selection(
        request: Request,
        actor: Actor = Depends(_require_actor),  # noqa: B008
    ) -> dict[str, object]:
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="request body must be a JSON object")
        if _contains_client_key(body, request.headers):
            raise HTTPException(
                status_code=400,
                detail="client-supplied upstreams, headers, or API keys are never accepted",
            )
        org_id = str(body.get("org_id") or "")
        if not org_id:
            raise HTTPException(status_code=400, detail="org_id is required")
        project_id = _optional_str(body.get("project_id"))
        action = "project:write" if project_id else "org:manage"
        _require_rbac(actor, action, Resource(org_id=org_id, project_id=project_id))
        routes = _selection_routes(body.get("routes"))
        catalog: ModelCatalog = request.app.state.catalog
        try:
            policy = catalog.policy_from_ids(routes)
        except RoutingError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        store: InMemoryModelSelectionStore = request.app.state.selection_store
        store.put(SelectionScope(org_id, project_id), policy)
        return {"org_id": org_id, "project_id": project_id, "routes": policy.to_selection_dict()}

    return app


def mint_lease_token(
    *,
    tenant_id: str,
    lease_id: str,
    expires_at: float,
    secret: str,
    run_id: str | None = None,
    project_id: str | None = None,
) -> str:
    payload = {
        "tenant_id": tenant_id,
        "lease_id": lease_id,
        "exp": expires_at,
        "run_id": run_id,
        "project_id": project_id,
    }
    body = _b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    sig = _sign(body, secret)
    return f"{body}.{sig}"


def verify_lease_token(token: str, *, secret: str, now: float | None = None) -> LeaseClaims:
    body, dot, sig = token.partition(".")
    if not dot or not hmac.compare_digest(sig, _sign(body, secret)):
        raise ValueError("lease token signature is invalid")
    try:
        payload = json.loads(_b64d(body))
        expires_at = float(payload["exp"])
        claims = LeaseClaims(
            tenant_id=str(payload["tenant_id"]),
            lease_id=str(payload["lease_id"]),
            run_id=_optional_str(payload.get("run_id")),
            project_id=_optional_str(payload.get("project_id")),
            expires_at=expires_at,
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("lease token payload is invalid") from exc
    if (now if now is not None else datetime.now(UTC).timestamp()) >= claims.expires_at:
        raise ValueError("lease token expired")
    return claims


def _policy_from_env(settings: RouterSettings) -> RoutingPolicy:
    # default_policy() is a development placeholder whose model names do not
    # exist upstream; the compose stack must boot with the verified Hugging
    # Face catalogue or every model call 400s with model_not_found.
    name = os.environ.get("LOOPIT_ROUTER_POLICY", "").strip().lower()
    if name in {"huggingface", "hf", "hf-router"}:
        return huggingface_router_policy(upstream_base_url=settings.upstream_base_url)
    if name in {"huggingface-unrestricted", "hf-unrestricted", "unrestricted"}:
        return huggingface_unrestricted_policy(
            upstream_base_url=settings.upstream_base_url,
            flash_base_url=os.environ.get("LOOPIT_ENDPOINT_GLM_FLASH_URL") or None,
            coder_base_url=os.environ.get("LOOPIT_ENDPOINT_QWEN38_URL") or None,
            planner_base_url=os.environ.get("LOOPIT_ENDPOINT_GLM53_URL") or None,
        )
    if name in {"", "default", "dev", "development"}:
        return default_policy(upstream_base_url=settings.upstream_base_url)
    raise SecretConfigurationError(
        f"LOOPIT_ROUTER_POLICY {name!r} is not supported; expected 'huggingface', "
        "'huggingface-unrestricted', or 'default'"
    )


def _build_router(
    settings: RouterSettings,
    ledger: QuotaLedger,
    audit: AuditSink,
    selection_store: InMemoryModelSelectionStore,
) -> ModelRouter:
    policy = _policy_from_env(settings)
    refs = {spec.credential_ref for route in policy.routes.values() for spec in route}
    secrets = StaticSecretResolver({ref: settings.model_api_key for ref in refs})
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(
            base_url=settings.upstream_base_url,
            bill_to=settings.upstream_bill_to,
            scale_up_timeout_s=600,
        )
    )
    return ModelRouter(
        policy=policy,
        upstream=upstream,
        ledger=ledger,
        secrets=secrets,
        audit=audit,
        selection_store=selection_store,
    )


def _audit_sink(settings: RouterSettings) -> AuditSink:
    if not settings.store_dsn:
        return StoreAuditSink(InMemoryAuditStore())
    return StoreAuditSink(PostgresAuditStore(connect(settings.store_dsn)))


def _ensure_quota(ledger: QuotaLedger, tenant_id: str, default_credit_limit: float) -> None:
    try:
        ledger.quota_for(tenant_id)
    except Exception:
        ledger.set_quota(TenantQuota(tenant_id=tenant_id, credit_limit=default_credit_limit))


def _require_lease_claims(
    request: Request, authorization: str | None = Header(default=None)
) -> LeaseClaims:
    settings: RouterSettings = request.app.state.settings
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="lease or identity bearer token required")
    token = authorization[7:].strip()
    try:
        return verify_lease_token(token, secret=settings.lease_token_secret)
    except ValueError:
        pass
    # Portal chat (LibreChat) authenticates with a Loop-it identity JWT. The
    # sandbox path still uses lease tokens. Upstream model keys stay server-side (I5).
    signer: TokenSigner = request.app.state.identity_signer
    try:
        identity = signer.verify_identity(token)
    except IdentityTokenError as exc:
        raise HTTPException(
            status_code=401, detail="invalid or expired lease or identity token"
        ) from exc
    now = datetime.now(UTC).timestamp()
    return LeaseClaims(
        tenant_id=identity.org_id,
        lease_id=f"portal-{identity.subject}",
        run_id=None,
        project_id=None,
        expires_at=now + 3600,
    )


def _contains_client_key(body: Mapping[str, Any], headers: Mapping[str, str]) -> bool:
    forbidden = {
        "api_key",
        "upstream_api_key",
        "provider_api_key",
        "credential_ref",
        "upstream",
        "upstream_base_url",
        "base_url",
        "extra_headers",
    }
    if any(key in body for key in forbidden):
        return True
    return any(
        name.lower() in {"authorization", "x-api-key", "x-upstream-api-key", "x-provider-api-key"}
        and name.lower() != "authorization"
        for name in headers
    )


def _require_actor(request: Request, authorization: str | None = Header(default=None)) -> Actor:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="identity bearer token required")
    signer: TokenSigner = request.app.state.identity_signer
    try:
        identity = signer.verify_identity(authorization[7:].strip())
    except IdentityTokenError as exc:
        raise HTTPException(status_code=401, detail="invalid or expired identity token") from exc
    return Actor.from_claims(
        subject=identity.subject,
        org_id=identity.org_id,
        role=identity.role,
        scopes=identity.scopes,
    )


def _require_rbac(actor: Actor, action: Any, resource: Resource) -> None:
    if not authorize(actor, action, resource):
        raise HTTPException(status_code=403, detail="not authorized")


def _selection_routes(raw: object) -> dict[Difficulty, Sequence[str]]:
    if not isinstance(raw, Mapping):
        raise HTTPException(status_code=400, detail="routes must be an object")
    routes: dict[Difficulty, Sequence[str]] = {}
    for difficulty in DIFFICULTIES:
        model_ids = raw.get(difficulty)
        if not isinstance(model_ids, list) or not all(isinstance(item, str) for item in model_ids):
            raise HTTPException(
                status_code=400,
                detail=f"routes.{difficulty} must be an array of model ids",
            )
        routes[difficulty] = tuple(model_ids)
    return routes


def _difficulty(value: str) -> Difficulty:
    if value in {"trivial", "implementation", "planning"}:
        return value  # type: ignore[return-value]
    return "implementation"


def _messages(raw: Sequence[Any]) -> list[Mapping[str, Any]]:
    messages: list[Mapping[str, Any]] = []
    for item in raw:
        if not isinstance(item, Mapping):
            raise HTTPException(status_code=400, detail="each message must be an object")
        messages.append(dict(item))
    return messages


def _response_schema(body: Mapping[str, Any]) -> Mapping[str, Any] | None:
    fmt = body.get("response_format")
    if isinstance(fmt, Mapping) and fmt.get("type") == "json_schema":
        schema = fmt.get("json_schema")
        if isinstance(schema, Mapping) and isinstance(schema.get("schema"), Mapping):
            response_schema = schema["schema"]
            return response_schema if isinstance(response_schema, Mapping) else None
    return None


def _max_tokens(body: Mapping[str, Any]) -> int | None:
    value = body.get("max_tokens", body.get("max_completion_tokens"))
    if value is None:
        return max_output_tokens_from_env()
    parsed = int(value)
    if parsed <= 0:
        raise HTTPException(status_code=400, detail="max_tokens must be a positive integer")
    return parsed


def _openai_response(result: UpstreamResult) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": result.content}
    if result.tool_calls:
        message["tool_calls"] = list(result.tool_calls)
    return {
        "id": f"chatcmpl-loopit-{result.model or 'model'}",
        "object": "chat.completion",
        "created": int(datetime.now(UTC).timestamp()),
        "model": result.model,
        "choices": [{"index": 0, "message": message, "finish_reason": result.finish_reason}],
        "usage": {
            "prompt_tokens": result.input_tokens,
            "completion_tokens": result.output_tokens,
            "total_tokens": result.total_tokens,
        },
    }


def setup_json_logging() -> None:
    logging.basicConfig(level=os.environ.get("LOOPIT_LOG_LEVEL", "INFO"), format="%(message)s")


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign(body: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode(), body.encode(), sha256).digest())


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def _env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, str(default)))


app = create_app(audit=InMemoryAuditSink())


def main() -> None:
    settings = RouterSettings.from_env()
    uvicorn.run(create_app(settings=settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
