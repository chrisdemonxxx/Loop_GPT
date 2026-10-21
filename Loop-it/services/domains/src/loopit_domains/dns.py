"""DNS adapters.

The service writes only the records needed to prove or route a hostname. A
real provider is isolated behind this seam so tests never need network access
and so secret material stays in environment-backed construction code.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable

DnsRecordType = Literal["A", "AAAA", "CNAME", "TXT"]


@dataclass(frozen=True, slots=True)
class DnsRecord:
    record_id: str
    zone: str
    name: str
    type: DnsRecordType
    content: str
    ttl: int = 300
    proxied: bool = False


@runtime_checkable
class DnsProvider(Protocol):
    """Minimal DNS provider contract for routing and ownership challenges."""

    def create_record(
        self,
        *,
        zone: str,
        name: str,
        type: DnsRecordType,
        content: str,
        ttl: int = 300,
        proxied: bool = False,
    ) -> DnsRecord: ...

    def update_record(
        self,
        *,
        zone: str,
        record_id: str,
        name: str,
        type: DnsRecordType,
        content: str,
        ttl: int = 300,
        proxied: bool = False,
    ) -> DnsRecord: ...

    def delete_record(self, *, zone: str, record_id: str) -> None: ...

    def list_records(
        self, *, zone: str, name: str | None = None, type: DnsRecordType | None = None
    ) -> tuple[DnsRecord, ...]: ...


@runtime_checkable
class PublicDnsResolver(Protocol):
    """Read-only public DNS resolver for customer-owned challenge records."""

    def resolve_txt(self, name: str) -> tuple[str, ...]: ...


class InMemoryDnsProvider:
    """Deterministic DNS fake with enough behaviour to catch ownership bugs."""

    def __init__(self) -> None:
        self._records: dict[str, DnsRecord] = {}
        self._counter = 0

    def create_record(
        self,
        *,
        zone: str,
        name: str,
        type: DnsRecordType,
        content: str,
        ttl: int = 300,
        proxied: bool = False,
    ) -> DnsRecord:
        self._counter += 1
        record = DnsRecord(
            record_id=f"dns_{self._counter}",
            zone=zone,
            name=name.lower(),
            type=type,
            content=content,
            ttl=ttl,
            proxied=proxied,
        )
        self._records[record.record_id] = record
        return record

    def update_record(
        self,
        *,
        zone: str,
        record_id: str,
        name: str,
        type: DnsRecordType,
        content: str,
        ttl: int = 300,
        proxied: bool = False,
    ) -> DnsRecord:
        if record_id not in self._records:
            raise KeyError(record_id)
        record = DnsRecord(record_id, zone, name.lower(), type, content, ttl, proxied)
        self._records[record_id] = record
        return record

    def delete_record(self, *, zone: str, record_id: str) -> None:
        record = self._records.get(record_id)
        if record is not None and record.zone == zone:
            del self._records[record_id]

    def list_records(
        self, *, zone: str, name: str | None = None, type: DnsRecordType | None = None
    ) -> tuple[DnsRecord, ...]:
        normalized = name.lower() if name is not None else None
        return tuple(
            record
            for record in self._records.values()
            if record.zone == zone
            and (normalized is None or record.name == normalized)
            and (type is None or record.type == type)
        )


class InMemoryPublicDnsResolver:
    """Test resolver that represents records visible in the customer's DNS zone."""

    def __init__(self) -> None:
        self._txt_records: dict[str, tuple[str, ...]] = {}

    def set_txt(self, name: str, *values: str) -> None:
        self._txt_records[name.lower().rstrip(".")] = tuple(values)

    def resolve_txt(self, name: str) -> tuple[str, ...]:
        return self._txt_records.get(name.lower().rstrip("."), ())


class DohPublicDnsResolver:
    """DNS-over-HTTPS TXT resolver used for public customer DNS verification."""

    def __init__(self, *, endpoint: str = "https://cloudflare-dns.com/dns-query") -> None:
        self._endpoint = endpoint

    def resolve_txt(self, name: str) -> tuple[str, ...]:
        httpx = _httpx()
        response = httpx.get(
            self._endpoint,
            headers={"Accept": "application/dns-json"},
            params={"name": name.rstrip("."), "type": "TXT"},
            timeout=10,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            return ()
        answers = payload.get("Answer", [])
        if not isinstance(answers, list):
            return ()
        values: list[str] = []
        for answer in answers:
            if not isinstance(answer, dict) or int(answer.get("type", 0)) != 16:
                continue
            data = answer.get("data", "")
            if isinstance(data, str):
                values.append(data)
        return tuple(values)


class CloudflareDnsProvider:
    """Cloudflare REST adapter; HTTP is imported lazily to keep tests offline."""

    def __init__(
        self,
        *,
        api_token: str,
        account_id: str,
        api_base: str = "https://api.cloudflare.com/client/v4",
    ) -> None:
        self._api_token = api_token
        self._account_id = account_id
        self._api_base = api_base.rstrip("/")
        self._zones: dict[str, str] = {}

    def create_record(
        self,
        *,
        zone: str,
        name: str,
        type: DnsRecordType,
        content: str,
        ttl: int = 300,
        proxied: bool = False,
    ) -> DnsRecord:
        httpx = _httpx()
        zone_id = self._zone_id(zone)
        response = httpx.post(
            f"{self._api_base}/zones/{zone_id}/dns_records",
            headers=self._headers(),
            json={
                "name": name,
                "type": type,
                "content": content,
                "ttl": ttl,
                "proxied": proxied,
            },
            timeout=15,
        )
        data = self._result(response)
        return _record_from_cloudflare(zone, data)

    def update_record(
        self,
        *,
        zone: str,
        record_id: str,
        name: str,
        type: DnsRecordType,
        content: str,
        ttl: int = 300,
        proxied: bool = False,
    ) -> DnsRecord:
        httpx = _httpx()
        zone_id = self._zone_id(zone)
        response = httpx.put(
            f"{self._api_base}/zones/{zone_id}/dns_records/{record_id}",
            headers=self._headers(),
            json={
                "name": name,
                "type": type,
                "content": content,
                "ttl": ttl,
                "proxied": proxied,
            },
            timeout=15,
        )
        data = self._result(response)
        return _record_from_cloudflare(zone, data)

    def delete_record(self, *, zone: str, record_id: str) -> None:
        httpx = _httpx()
        zone_id = self._zone_id(zone)
        response = httpx.delete(
            f"{self._api_base}/zones/{zone_id}/dns_records/{record_id}",
            headers=self._headers(),
            timeout=15,
        )
        self._result(response)

    def list_records(
        self, *, zone: str, name: str | None = None, type: DnsRecordType | None = None
    ) -> tuple[DnsRecord, ...]:
        httpx = _httpx()
        zone_id = self._zone_id(zone)
        params: dict[str, str] = {}
        if name is not None:
            params["name"] = name
        if type is not None:
            params["type"] = type
        response = httpx.get(
            f"{self._api_base}/zones/{zone_id}/dns_records",
            headers=self._headers(),
            params=params,
            timeout=15,
        )
        payload = self._payload(response)
        result = payload.get("result", [])
        if not isinstance(result, list):
            raise RuntimeError("Cloudflare returned malformed DNS record list")
        return tuple(_record_from_cloudflare(zone, item) for item in result)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_token}", "Content-Type": "application/json"}

    def _zone_id(self, zone: str) -> str:
        cached = self._zones.get(zone)
        if cached is not None:
            return cached
        httpx = _httpx()
        response = httpx.get(
            f"{self._api_base}/zones",
            headers=self._headers(),
            params={"name": zone, "account.id": self._account_id},
            timeout=15,
        )
        payload = self._payload(response)
        result = payload.get("result", [])
        if not isinstance(result, list) or not result:
            raise RuntimeError(f"Cloudflare zone {zone!r} was not found")
        zone_id = str(result[0]["id"])
        self._zones[zone] = zone_id
        return zone_id

    def _payload(self, response: Any) -> dict[str, Any]:
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise RuntimeError("Cloudflare DNS request failed")
        return payload

    def _result(self, response: Any) -> dict[str, Any]:
        payload = self._payload(response)
        result = payload.get("result", {})
        if not isinstance(result, dict):
            raise RuntimeError("Cloudflare returned malformed DNS record")
        return result


def _record_from_cloudflare(zone: str, data: dict[str, Any]) -> DnsRecord:
    record_type = str(data.get("type", "TXT"))
    if record_type not in {"A", "AAAA", "CNAME", "TXT"}:
        raise RuntimeError(f"unsupported DNS record type {record_type!r}")
    return DnsRecord(
        record_id=str(data["id"]),
        zone=zone,
        name=str(data["name"]).lower(),
        type=record_type,  # type: ignore[arg-type]
        content=str(data["content"]),
        ttl=int(data.get("ttl", 300)),
        proxied=bool(data.get("proxied", False)),
    )


def _httpx() -> Any:
    try:
        import httpx
    except ImportError as exc:
        raise RuntimeError("install httpx to use CloudflareDnsProvider") from exc
    return httpx
