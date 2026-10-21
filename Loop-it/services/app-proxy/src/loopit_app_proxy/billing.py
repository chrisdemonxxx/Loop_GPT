"""Buffered hosting quota and egress reporting for the public app edge."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Protocol

import httpx2

LOG = logging.getLogger("loopit.app_proxy.billing")


class HostingBillingReporter(Protocol):
    def quota_refusal(self, host: str) -> str | None: ...

    async def report_egress(
        self, *, host: str, tenant_id: str, project_id: str, byte_count: int
    ) -> None: ...

    async def aclose(self) -> None: ...


class NoopHostingBillingReporter:
    def quota_refusal(self, host: str) -> str | None:
        del host
        return None

    async def report_egress(
        self, *, host: str, tenant_id: str, project_id: str, byte_count: int
    ) -> None:
        del host, tenant_id, project_id, byte_count

    async def aclose(self) -> None:
        return None


@dataclass(slots=True)
class _EgressBucket:
    tenant_id: str
    project_id: str
    pending_bytes: int = 0
    reported_today: int = 0
    day: int = 0
    last_flush_started: float = 0.0


@dataclass(slots=True)
class _QuotaRefusal:
    reason: str
    expires_at: float
    revalidating: bool = False


class BufferedHostingBillingReporter:
    """Aggregate egress locally and flush quota reservations outside request flow."""

    def __init__(
        self,
        *,
        billing_url: str,
        service_token: str,
        client: httpx2.AsyncClient | None = None,
        flush_bytes: int = 1_000_000,
        flush_interval_seconds: float = 5.0,
        refusal_ttl_seconds: float = 60.0,
        max_hosts: int = 10_000,
    ) -> None:
        if flush_bytes <= 0:
            raise ValueError("flush_bytes must be positive")
        if flush_interval_seconds <= 0:
            raise ValueError("flush_interval_seconds must be positive")
        if refusal_ttl_seconds <= 0:
            raise ValueError("refusal_ttl_seconds must be positive")
        if max_hosts <= 0:
            raise ValueError("max_hosts must be positive")
        self._billing_url = billing_url.rstrip("/")
        self._service_token = service_token
        self._client = client or httpx2.AsyncClient(timeout=httpx2.Timeout(5.0))
        self._owns_client = client is None
        self._flush_bytes = flush_bytes
        self._flush_interval_seconds = flush_interval_seconds
        self._refusal_ttl_seconds = refusal_ttl_seconds
        self._max_hosts = max_hosts
        self._buckets: OrderedDict[str, _EgressBucket] = OrderedDict()
        self._quota_refusals: OrderedDict[str, _QuotaRefusal] = OrderedDict()
        self._flush_tasks: set[asyncio.Task[None]] = set()
        self._lock = asyncio.Lock()

    def quota_refusal(self, host: str) -> str | None:
        refusal = self._quota_refusals.get(host)
        if refusal is None:
            return None
        self._quota_refusals.move_to_end(host)
        if time.time() >= refusal.expires_at and not refusal.revalidating:
            refusal.revalidating = True
            self._schedule_revalidation(host)
        return refusal.reason

    async def report_egress(
        self, *, host: str, tenant_id: str, project_id: str, byte_count: int
    ) -> None:
        if byte_count <= 0:
            return
        now = time.time()
        day = int(now // 86_400)
        should_flush = False
        async with self._lock:
            bucket = self._buckets.get(host)
            if bucket is None or bucket.day != day:
                bucket = _EgressBucket(tenant_id=tenant_id, project_id=project_id, day=day)
                self._buckets[host] = bucket
            bucket.tenant_id = tenant_id
            bucket.project_id = project_id
            bucket.pending_bytes += byte_count
            self._buckets.move_to_end(host)
            while len(self._buckets) > self._max_hosts:
                self._buckets.popitem(last=False)
            should_flush = (
                bucket.pending_bytes >= self._flush_bytes
                or now - bucket.last_flush_started >= self._flush_interval_seconds
            )
        if should_flush:
            self._schedule_flush(host)

    async def aclose(self) -> None:
        hosts = list(self._buckets)
        await asyncio.gather(*(self._flush(host) for host in hosts), return_exceptions=True)
        if self._flush_tasks:
            await asyncio.gather(*self._flush_tasks, return_exceptions=True)
        if self._owns_client:
            await self._client.aclose()

    def _schedule_flush(self, host: str) -> None:
        task = asyncio.create_task(self._flush(host))
        self._flush_tasks.add(task)
        task.add_done_callback(self._flush_tasks.discard)

    async def _flush(self, host: str) -> None:
        async with self._lock:
            bucket = self._buckets.get(host)
            if bucket is None or bucket.pending_bytes <= 0:
                return
            byte_count = bucket.pending_bytes
            bucket.pending_bytes = 0
            bucket.last_flush_started = time.time()
            tenant_id = bucket.tenant_id
            project_id = bucket.project_id
        try:
            response = await self._reserve_hosting_egress(
                tenant_id=tenant_id,
                project_id=project_id,
                host=host,
                byte_count=byte_count,
                key_prefix="app-proxy-egress",
            )
            if response.status_code == 429:
                reason = _quota_reason(response)
                async with self._lock:
                    self._remember_refusal(host, reason)
                return
            response.raise_for_status()
        except (httpx2.HTTPError, ValueError) as exc:
            LOG.warning("hosting egress billing flush failed", extra={"host": host}, exc_info=exc)
            async with self._lock:
                retry_bucket = self._buckets.get(host)
                if retry_bucket is not None:
                    retry_bucket.pending_bytes += byte_count
            return
        async with self._lock:
            flushed = self._buckets.get(host)
            if flushed is not None:
                flushed.reported_today += byte_count
            self._quota_refusals.pop(host, None)

    async def _revalidate_refusal(self, host: str) -> None:
        async with self._lock:
            bucket = self._buckets.get(host)
            if bucket is None:
                self._quota_refusals.pop(host, None)
                return
            tenant_id = bucket.tenant_id
            project_id = bucket.project_id
        try:
            response = await self._reserve_hosting_egress(
                tenant_id=tenant_id,
                project_id=project_id,
                host=host,
                # Ask for one real byte: a zero-byte request would succeed even
                # while the tenant remains exactly at the daily egress limit.
                byte_count=1,
                key_prefix="app-proxy-egress-revalidate",
            )
            if response.status_code == 429:
                reason = _quota_reason(response)
                async with self._lock:
                    self._remember_refusal(host, reason)
                return
            response.raise_for_status()
        except (httpx2.HTTPError, ValueError) as exc:
            LOG.warning(
                "hosting egress quota revalidation failed", extra={"host": host}, exc_info=exc
            )
            async with self._lock:
                refusal = self._quota_refusals.get(host)
                if refusal is not None:
                    refusal.expires_at = time.time() + self._refusal_ttl_seconds
                    refusal.revalidating = False
            return
        async with self._lock:
            self._quota_refusals.pop(host, None)

    async def _reserve_hosting_egress(
        self,
        *,
        tenant_id: str,
        project_id: str,
        host: str,
        byte_count: int,
        key_prefix: str,
    ) -> httpx2.Response:
        return await self._client.post(
            f"{self._billing_url}/v1/billing/reservations",
            headers=self._headers(),
            json={
                "estimated_cost": "0",
                "tenant_id": tenant_id,
                "idempotency_key": f"{key_prefix}:{tenant_id}:{project_id}:{host}:{time.time_ns()}",
                "quota_request": {"hosting_egress_bytes": byte_count},
            },
        )

    def _remember_refusal(self, host: str, reason: str) -> None:
        self._quota_refusals[host] = _QuotaRefusal(
            reason=reason, expires_at=time.time() + self._refusal_ttl_seconds
        )
        self._quota_refusals.move_to_end(host)
        while len(self._quota_refusals) > self._max_hosts:
            self._quota_refusals.popitem(last=False)

    def _schedule_revalidation(self, host: str) -> None:
        task = asyncio.create_task(self._revalidate_refusal(host))
        self._flush_tasks.add(task)
        task.add_done_callback(self._flush_tasks.discard)

    def _headers(self) -> dict[str, str]:
        return {
            "X-Loopit-Service-Token": self._service_token,
            "Authorization": f"Bearer {self._service_token}",
            "Content-Type": "application/json",
        }


def _quota_reason(response: httpx2.Response) -> str:
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    return str(detail or "hosting quota exceeded")
