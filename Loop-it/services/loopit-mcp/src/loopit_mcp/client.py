"""HTTP client for the Loop-it control-plane API."""

from __future__ import annotations

from typing import Any

import httpx


class LoopitApiError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class LoopitApiClient:
    """Forwards the caller's Loop-it identity JWT. Never stores model keys."""

    def __init__(
        self,
        base_url: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            transport=transport,
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        token: str,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        if not token.strip():
            raise LoopitApiError(401, "authentication required")
        response = self._client.request(
            method,
            path,
            headers={"Authorization": f"Bearer {token.strip()}"},
            json=json,
            params=params,
        )
        if response.status_code >= 400:
            detail = _error_detail(response)
            raise LoopitApiError(response.status_code, detail)
        if response.status_code == 204 or not response.content:
            return {}
        try:
            return response.json()
        except ValueError as exc:
            raise LoopitApiError(502, "control-plane returned non-JSON") from exc


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        text = response.text.strip()
        return text or f"HTTP {response.status_code}"
    if isinstance(payload, dict) and payload.get("detail") is not None:
        return str(payload["detail"])
    return str(payload)
