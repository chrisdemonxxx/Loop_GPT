"""Report Loop-it meter events to Loop-GPT's usage ledger.

Loop-GPT is the billing system of record once ``LOOPIT_USAGE_REPORT_URL`` is
set. This reporter posts the same idempotency key the local ledger already
used, so a retry cannot charge either side twice. It does not call Stripe.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

from loopit_auth import TokenSigner

from .metering import MeterEvent

Transport = Callable[[str, dict[str, Any], str], None]


class UsageReportError(Exception):
    """The Loop-GPT usage endpoint could not be reached or rejected the event."""


class UsageReporter:
    def __init__(
        self, url: str, signer: TokenSigner, *, transport: Transport | None = None
    ) -> None:
        self._url = url.strip()
        self._signer = signer
        self._transport = transport

    @property
    def url(self) -> str:
        return self._url

    def report(self, event: MeterEvent) -> None:
        if not self._url:
            return
        parsed = urlparse(self._url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise UsageReportError("usage report URL is invalid")
        token = self._signer.mint_identity(
            subject="loopit-billing",
            org_id=event.tenant_id,
            role="owner",
            scopes=("api", "runs"),
            ttl_seconds=120,
        )
        body = _payload(event)
        if self._transport is not None:
            try:
                self._transport(self._url, body, token)
            except UsageReportError:
                raise
            except Exception as exc:
                raise UsageReportError("usage report failed") from exc
            return
        _post(self._url, body, token)


def _payload(event: MeterEvent) -> dict[str, Any]:
    body: dict[str, Any] = {
        "idempotencyKey": event.idempotency_key,
        "kind": event.kind,
        "inputTokens": event.input_tokens,
        "outputTokens": event.output_tokens,
        "cachedInputTokens": event.cached_input_tokens,
        "sandboxSeconds": event.sandbox_seconds,
        "hostingSeconds": event.hosting_seconds,
        "storageGbMonths": float(event.storage_gb_months),
        "customDomainMonths": float(event.custom_domain_months),
        "tenantId": event.tenant_id,
    }
    if event.model:
        body["model"] = event.model
    if event.run_id:
        body["runId"] = event.run_id
    return body


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(  # type: ignore[override]
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        raise UsageReportError("usage report URL redirected")


def _post(url: str, body: dict[str, Any], token: str) -> None:
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(  # noqa: S310 - scheme is checked before this call
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    opener = urllib.request.build_opener(_RefuseRedirect)
    try:
        with opener.open(request, timeout=5) as response:
            status = getattr(response, "status", 200)
            if status >= 300:
                raise UsageReportError(f"usage report failed with HTTP {status}")
    except UsageReportError:
        raise
    except Exception as exc:
        raise UsageReportError("usage report failed") from exc
