"""Bill each model call to the parent's credits (Loop-GPT ``/api/loopit/usage``).

The engine's own quota ledger only protects the engine. The person paying is
on Loop-GPT, so every model response's token usage is posted there as an
``inference`` event, keyed per call so a retried post is never charged twice.

Metering fails closed. A run that cannot be billed stops: 402 means the
person is out of credits, any other refusal or an unreachable parent means
usage would go unrecorded, and neither should keep spending.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from loopit_agent_core.model import Difficulty, Message, ModelClient, ModelResponse
from loopit_router.quota import QuotaExceeded

LOGGER = logging.getLogger(__name__)

#: ``(url, json_body, bearer_token) -> (status, response_text)``. Raises
#: ``OSError`` when the parent cannot be reached at all.
UsagePost = Callable[[str, Mapping[str, Any], str], tuple[int, str]]


class CreditsExhausted(QuotaExceeded):
    """The parent refused the charge because the person is out of credits."""

    def __init__(self, tenant_id: str, detail: str) -> None:
        super().__init__(tenant_id, 0.0, 0.0)
        self.detail = detail


class MeteringUnavailable(RuntimeError):
    """Usage could not be recorded, so the run must not continue spending."""


def _post_json(url: str, body: Mapping[str, Any], token: str) -> tuple[int, str]:
    request = urllib.request.Request(  # noqa: S310 - operator-configured https/http URL
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            return int(response.status), response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        return int(error.code), error.read().decode("utf-8", errors="replace")


def _get_json(url: str, token: str) -> tuple[int, str]:
    request = urllib.request.Request(  # noqa: S310 - operator-configured https/http URL
        url,
        method="GET",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            return int(response.status), response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        return int(error.code), error.read().decode("utf-8", errors="replace")


def credits_url_from_usage(usage_url: str) -> str:
    """Derive ``/api/loopit/credits`` from the configured usage URL."""
    trimmed = usage_url.rstrip("/")
    if trimmed.endswith("/usage"):
        return f"{trimmed[: -len('/usage')]}/credits"
    return f"{trimmed}/credits"


class LoopGptUsageMeter:
    """Posts one ``inference`` usage event per model call."""

    def __init__(
        self,
        *,
        url: str,
        signer: Any,
        post: UsagePost | None = None,
        get: Callable[[str, str], tuple[int, str]] | None = None,
        attempts: int = 3,
        backoff_seconds: float = 0.5,
        credits_url: str | None = None,
    ) -> None:
        self._url = url
        self._credits_url = credits_url or credits_url_from_usage(url)
        self._signer = signer
        self._post = post or _post_json
        self._get = get or _get_json
        self._attempts = max(1, attempts)
        self._backoff = backoff_seconds

    def _mint(self, *, tenant_id: str, actor_id: str) -> str:
        return self._signer.mint_identity(
            subject=actor_id,
            org_id=tenant_id,
            role="member",
            scopes=("api", "runs"),
            ttl_seconds=300,
        )

    def ensure_credits(
        self,
        *,
        tenant_id: str,
        actor_id: str,
        minimum: int = 1,
    ) -> None:
        """Fail closed when the parent reports fewer than ``minimum`` credits.

        Called before a run starts so a zero-balance org never leases work or
        burns a model turn. Unlimited / admin accounts skip the minimum.
        """
        token = self._mint(tenant_id=tenant_id, actor_id=actor_id)
        last_problem = "no attempt made"
        for attempt in range(self._attempts):
            if attempt:
                time.sleep(self._backoff * attempt)
            try:
                status, text = self._get(self._credits_url, token)
            except OSError as error:
                last_problem = f"unreachable: {error}"
                continue
            if 200 <= status < 300:
                try:
                    body = json.loads(text)
                except ValueError as error:
                    raise MeteringUnavailable("credits response was not JSON") from error
                if not isinstance(body, dict):
                    raise MeteringUnavailable("credits response was not an object")
                if body.get("unlimited") is True:
                    return
                try:
                    credits = int(body.get("credits", 0))
                except (TypeError, ValueError) as error:
                    raise MeteringUnavailable("credits response missing credits") from error
                if credits < minimum:
                    raise CreditsExhausted(tenant_id, "out of credits")
                return
            if status == 402:
                raise CreditsExhausted(tenant_id, _error_text(text) or "out of credits")
            if status >= 500 or status == 429:
                last_problem = f"HTTP {status}"
                continue
            raise MeteringUnavailable(f"credits check was refused (HTTP {status}): {_error_text(text)}")
        raise MeteringUnavailable(f"credits could not be checked ({last_problem})")

    def record(
        self,
        *,
        run_id: str,
        tenant_id: str,
        actor_id: str,
        call_index: int,
        response: ModelResponse,
    ) -> None:
        if response.input_tokens + response.output_tokens <= 0:
            # Scripted/offline replies carry no usage, and the parent rejects
            # an inference event with nothing to charge.
            return
        token = self._mint(tenant_id=tenant_id, actor_id=actor_id)
        body = {
            "idempotencyKey": f"{run_id}:model:{call_index}",
            "kind": "inference",
            "model": response.model,
            "inputTokens": response.input_tokens,
            "outputTokens": response.output_tokens,
            "cachedInputTokens": response.cached_input_tokens,
            "runId": run_id,
        }
        last_problem = "no attempt made"
        for attempt in range(self._attempts):
            if attempt:
                time.sleep(self._backoff * attempt)
            try:
                status, text = self._post(self._url, body, token)
            except OSError as error:
                last_problem = f"unreachable: {error}"
                continue
            if 200 <= status < 300:
                return
            if status == 402:
                raise CreditsExhausted(tenant_id, _error_text(text) or "out of credits")
            if status >= 500 or status == 429:
                last_problem = f"HTTP {status}"
                continue
            raise MeteringUnavailable(f"usage was refused (HTTP {status}): {_error_text(text)}")
        raise MeteringUnavailable(f"usage could not be recorded ({last_problem})")


def _error_text(text: str) -> str:
    try:
        parsed = json.loads(text)
    except ValueError:
        return text[:200]
    if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
        return str(parsed["error"])
    return text[:200]


class MeteredModelClient:
    """A ``ModelClient`` that bills every completion before the loop sees it."""

    def __init__(self, inner: ModelClient, charge: Callable[[int, ModelResponse], None]) -> None:
        self._inner = inner
        self._charge = charge
        self._calls = 0
        self._refusal: Exception | None = None

    def complete(
        self,
        messages: Sequence[Message],
        *,
        difficulty: Difficulty,
        response_schema: Mapping[str, Any] | None = None,
        on_token: Callable[[str], None] | None = None,
    ) -> ModelResponse:
        # Some callers (the brief) swallow model errors and carry on; once a
        # charge is refused, no further call may spend before the run stops.
        if self._refusal is not None:
            raise self._refusal
        response = self._inner.complete(
            messages,
            difficulty=difficulty,
            response_schema=response_schema,
            on_token=on_token,
        )
        self._calls += 1
        try:
            self._charge(self._calls, response)
        except (CreditsExhausted, MeteringUnavailable) as refusal:
            self._refusal = refusal
            raise
        return response


def usage_meter_from_env(signer: Any) -> LoopGptUsageMeter | None:
    """``LOOPIT_USAGE_URL`` (Loop-GPT backend ``/api/loopit/usage``) turns billing on."""
    url = os.environ.get("LOOPIT_USAGE_URL", "").strip()
    if not url:
        return None
    return LoopGptUsageMeter(url=url, signer=signer)
