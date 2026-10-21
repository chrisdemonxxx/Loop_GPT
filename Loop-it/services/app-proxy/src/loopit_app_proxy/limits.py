"""Small in-process protections for the public edge."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RateLimitSettings:
    requests_per_window: int = 600
    window_seconds: float = 60.0
    max_hosts: int = 10_000

    def __post_init__(self) -> None:
        if self.requests_per_window <= 0:
            raise ValueError("requests_per_window must be positive")
        if self.window_seconds <= 0:
            raise ValueError("window_seconds must be positive")
        if self.max_hosts <= 0:
            raise ValueError("max_hosts must be positive")


@dataclass(slots=True)
class _Bucket:
    window_started: float
    used: int = 0


class PerHostRateLimiter:
    """Fixed-window per-host limiter, deliberately independent of client IP."""

    def __init__(self, settings: RateLimitSettings) -> None:
        self._settings = settings
        self._buckets: OrderedDict[str, _Bucket] = OrderedDict()

    def allow(self, host: str, *, now: float) -> bool:
        bucket = self._buckets.get(host)
        if bucket is None or now - bucket.window_started >= self._settings.window_seconds:
            self._sweep_expired(now)
            self._buckets[host] = _Bucket(window_started=now, used=1)
            self._buckets.move_to_end(host)
            while len(self._buckets) > self._settings.max_hosts:
                self._buckets.popitem(last=False)
            return True
        self._buckets.move_to_end(host)
        if bucket.used >= self._settings.requests_per_window:
            return False
        bucket.used += 1
        return True

    def _sweep_expired(self, now: float) -> None:
        expired = [
            host
            for host, bucket in self._buckets.items()
            if now - bucket.window_started >= self._settings.window_seconds
        ]
        for host in expired:
            self._buckets.pop(host, None)


__all__ = ["PerHostRateLimiter", "RateLimitSettings"]
