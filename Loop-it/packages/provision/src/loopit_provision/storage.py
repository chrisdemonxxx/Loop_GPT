"""S3-compatible storage provisioning for generated apps."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

from loopit_secrets import Lease, SecretsBroker, SecretValue, StepContext


class StorageError(RuntimeError):
    """Storage provisioning or access failed."""


@dataclass(frozen=True, slots=True)
class StorageBucket:
    """Non-secret bucket metadata for one generated app."""

    bucket: str
    prefix: str


@dataclass(frozen=True, slots=True)
class StorageObject:
    """A fake S3 object scoped by project prefix."""

    key: str
    body: bytes


class StorageProvisioner(Protocol):
    """Creates bucket/prefix isolation for one generated app."""

    def provision_bucket(self, tenant_id: str, project_id: str) -> StorageBucket: ...


class InMemoryStorageProvisioner:
    """Fake S3/R2/Tigris adapter that enforces per-project prefixes."""

    def __init__(self, *, bucket: str = "loopit-generated-apps") -> None:
        self.bucket = bucket
        self._objects: dict[str, StorageObject] = {}

    def provision_bucket(self, tenant_id: str, project_id: str) -> StorageBucket:
        return StorageBucket(bucket=self.bucket, prefix=f"{tenant_id}/{project_id}/")

    def put_object(self, scope: StorageBucket, key: str, body: bytes) -> None:
        full_key = self._full_key(scope, key)
        self._objects[full_key] = StorageObject(key=full_key, body=body)

    def get_object(self, scope: StorageBucket, key: str) -> bytes:
        full_key = self._full_key(scope, key)
        try:
            return self._objects[full_key].body
        except KeyError as exc:
            raise StorageError(f"object {key!r} is outside this project scope or missing") from exc

    def _full_key(self, scope: StorageBucket, key: str) -> str:
        clean = key.lstrip("/")
        if clean.startswith("../") or "/../" in clean or clean == "..":
            raise StorageError("storage key may not escape the project prefix")
        return scope.prefix + clean


@dataclass(frozen=True, slots=True)
class StorageCredentialLeases:
    """Lease handles for scoped storage credentials; no plaintext is stored here."""

    access_key_id: Lease
    secret_access_key: Lease


class StorageCredentialIssuer:
    """Issues JIT leases for project-scoped S3 credentials via ``loopit_secrets``."""

    access_key_name = "S3_ACCESS_KEY_ID"
    secret_key_name = "S3_SECRET_ACCESS_KEY"  # noqa: S105 - secret name, not value

    def __init__(self, broker: SecretsBroker, *, ttl: timedelta = timedelta(minutes=5)) -> None:
        self._broker = broker
        self._ttl = ttl

    def issue(self, context: StepContext) -> StorageCredentialLeases:
        return StorageCredentialLeases(
            access_key_id=self._broker.issue(context, self.access_key_name, ttl=self._ttl),
            secret_access_key=self._broker.issue(context, self.secret_key_name, ttl=self._ttl),
        )

    def reveal_for_step(self, leases: StorageCredentialLeases) -> tuple[SecretValue, SecretValue]:
        return (
            SecretValue(self._broker.reveal(leases.access_key_id)),
            SecretValue(self._broker.reveal(leases.secret_access_key)),
        )


__all__ = [
    "InMemoryStorageProvisioner",
    "StorageBucket",
    "StorageCredentialIssuer",
    "StorageCredentialLeases",
    "StorageError",
    "StorageObject",
    "StorageProvisioner",
]
