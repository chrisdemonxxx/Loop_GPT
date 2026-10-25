"""The secret store — where the build↔prod firewall is made structural.

Doc 06 §4.3 requires a bidirectional firewall: a compromised build must never
reach production data, and vice versa. The tempting way to enforce that is a
comparison at resolve time — ``if secret.environment != caller.environment:
deny`` — but that is exactly the flag prompt injection can flip, and exactly the
line a refactor can drop. So the separation is built into the data instead.

Each store instance holds secrets for *one* :class:`Environment`. It refuses at
insert time to hold a secret of any other environment, and it refuses to hold any
platform-owned class at all — a project store physically cannot contain a model
key, a cloud credential, or another tenant's secret. A broker is then wired to a
single store (:mod:`loopit_secrets.broker`), so a build-plane broker holds no
reference to the prod store and has no method that takes an environment argument.
Resolving a prod secret from a build broker is therefore not a denied path; it is
not a path at all.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import uuid
from collections.abc import Iterable, Mapping, MutableMapping
from dataclasses import dataclass, field
from typing import Any, Protocol, cast

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from loopit_agent_core.config import is_placeholder_secret

from .environment import Environment, SecretClass
from .errors import (
    EnvironmentMismatch,
    PlatformSecretForbidden,
    SecretStoreConfigurationError,
    SecretStoreIntegrityError,
)
from .values import SecretValue

#: The composite identity of a secret within one environment's store.
_Key = tuple[str, str, str]


@dataclass(frozen=True, slots=True)
class StoredSecret:
    """A secret at rest: its identity, its ownership class, and its value.

    The ``value`` is a :class:`SecretValue` and is excluded from ``repr`` so a
    stored secret cannot leak its plaintext through logging or a debugger.
    """

    name: str
    environment: Environment
    secret_class: SecretClass
    tenant_id: str
    project_id: str
    value: SecretValue = field(repr=False)


@dataclass(frozen=True, slots=True)
class RootKey:
    """An AES-256-GCM wrapping key loaded from trusted process configuration."""

    key_id: str
    key: bytes = field(repr=False)

    def __post_init__(self) -> None:
        if len(self.key) != 32:
            raise SecretStoreConfigurationError("secret root key must decode to exactly 32 bytes")
        if not self.key_id:
            raise SecretStoreConfigurationError("secret root key id must be non-empty")


@dataclass(frozen=True, slots=True)
class EncryptedSecretRecord:
    """The row shape persisted in ``packages/store``'s ``secrets`` table."""

    secret_id: str
    tenant_id: str
    project_id: str
    name: str
    encrypted_blob: bytes = field(repr=False)
    encryption_key_ref: str
    metadata: Mapping[str, Any] = field(repr=False)


class EncryptedSecretRepository(Protocol):
    """Minimal repository seam for encrypted secret rows."""

    def put(self, record: EncryptedSecretRecord) -> None: ...

    def get(self, tenant_id: str, project_id: str, name: str) -> EncryptedSecretRecord | None: ...

    def list_by_environment_and_root_key(
        self, environment: Environment, root_key_id: str
    ) -> Iterable[EncryptedSecretRecord]: ...

    def update_envelope(self, record: EncryptedSecretRecord) -> None: ...


def load_root_key_from_env(
    env: Mapping[str, str] | None = None,
    *,
    key_var: str = "LOOPIT_SECRETS_ROOT_KEY",
    key_id_var: str = "LOOPIT_SECRETS_ROOT_KEY_ID",
) -> RootKey:
    """Load the envelope-encryption root key, failing closed if it is unusable."""

    source = os.environ if env is None else env
    encoded = source.get(key_var)
    if not encoded:
        raise SecretStoreConfigurationError(f"{key_var} must be set for persistent secret storage")
    if is_placeholder_secret(encoded):
        raise SecretStoreConfigurationError(f"{key_var} must not use a placeholder value")
    try:
        key = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SecretStoreConfigurationError(f"{key_var} must be base64-encoded") from exc
    return RootKey(key_id=source.get(key_id_var, "env:LOOPIT_SECRETS_ROOT_KEY"), key=key)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(value: object, *, field_name: str) -> bytes:
    if not isinstance(value, str):
        raise SecretStoreIntegrityError(f"encrypted secret metadata {field_name} is missing")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SecretStoreIntegrityError(
            f"encrypted secret metadata {field_name} is invalid"
        ) from exc


def _scope_aad(
    *,
    tenant_id: str,
    project_id: str,
    environment: Environment,
    name: str,
    root_key_id: str | None = None,
) -> bytes:
    body: dict[str, str] = {
        "tenant_id": tenant_id,
        "project_id": project_id,
        "environment": environment.value,
        "name": name,
    }
    if root_key_id is not None:
        body["root_key_id"] = root_key_id
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")


class EnvelopeSecretCodec:
    """Envelope encryption for one root key.

    Plaintext is encrypted with a fresh per-secret data key; the data key is
    wrapped by the root key. Both AES-GCM operations bind tenant, project,
    environment, and name as AAD so ciphertext replay into another scope fails
    authentication instead of producing plaintext.
    """

    algorithm = "AES-256-GCM+envelope-v1"

    def __init__(self, root_key: RootKey) -> None:
        self._root_key = root_key

    @property
    def root_key(self) -> RootKey:
        return self._root_key

    @root_key.setter
    def root_key(self, value: RootKey) -> None:
        self._root_key = value

    def encrypt(self, secret: StoredSecret) -> EncryptedSecretRecord:
        data_key = AESGCM.generate_key(bit_length=256)
        data_nonce = os.urandom(12)
        value_nonce = os.urandom(12)
        value_aad = _scope_aad(
            tenant_id=secret.tenant_id,
            project_id=secret.project_id,
            environment=secret.environment,
            name=secret.name,
        )
        key_aad = _scope_aad(
            tenant_id=secret.tenant_id,
            project_id=secret.project_id,
            environment=secret.environment,
            name=secret.name,
            root_key_id=self._root_key.key_id,
        )
        encrypted_blob = AESGCM(data_key).encrypt(
            value_nonce, secret.value.reveal().encode("utf-8"), value_aad
        )
        wrapped_data_key = AESGCM(self._root_key.key).encrypt(data_nonce, data_key, key_aad)
        metadata: dict[str, Any] = {
            "algorithm": self.algorithm,
            "environment": secret.environment.value,
            "secret_class": secret.secret_class.value,
            "root_key_id": self._root_key.key_id,
            "value_nonce": _b64(value_nonce),
            "data_key_nonce": _b64(data_nonce),
            "wrapped_data_key": _b64(wrapped_data_key),
        }
        return EncryptedSecretRecord(
            secret_id=f"secret_{uuid.uuid4().hex}",
            tenant_id=secret.tenant_id,
            project_id=secret.project_id,
            name=secret.name,
            encrypted_blob=encrypted_blob,
            encryption_key_ref=self._root_key.key_id,
            metadata=metadata,
        )

    def decrypt(self, record: EncryptedSecretRecord) -> StoredSecret:
        metadata = dict(record.metadata)
        environment = self._environment(metadata)
        secret_class = self._secret_class(metadata)
        root_key_id = self._root_key_id(record, metadata)
        if root_key_id != self._root_key.key_id:
            raise SecretStoreConfigurationError(
                f"secret {record.name!r} is wrapped by unavailable root key {root_key_id!r}"
            )

        key_aad = _scope_aad(
            tenant_id=record.tenant_id,
            project_id=record.project_id,
            environment=environment,
            name=record.name,
            root_key_id=root_key_id,
        )
        value_aad = _scope_aad(
            tenant_id=record.tenant_id,
            project_id=record.project_id,
            environment=environment,
            name=record.name,
        )
        try:
            data_key = AESGCM(self._root_key.key).decrypt(
                _unb64(metadata.get("data_key_nonce"), field_name="data_key_nonce"),
                _unb64(metadata.get("wrapped_data_key"), field_name="wrapped_data_key"),
                key_aad,
            )
            plaintext = AESGCM(data_key).decrypt(
                _unb64(metadata.get("value_nonce"), field_name="value_nonce"),
                record.encrypted_blob,
                value_aad,
            )
        except InvalidTag as exc:
            raise SecretStoreIntegrityError(
                "encrypted secret failed authenticated verification"
            ) from exc

        return StoredSecret(
            name=record.name,
            environment=environment,
            secret_class=secret_class,
            tenant_id=record.tenant_id,
            project_id=record.project_id,
            value=SecretValue(plaintext.decode("utf-8")),
        )

    def rewrap_data_key(
        self, record: EncryptedSecretRecord, new_root_key: RootKey
    ) -> EncryptedSecretRecord:
        metadata = dict(record.metadata)
        environment = self._environment(metadata)
        old_root_key_id = self._root_key_id(record, metadata)
        if old_root_key_id != self._root_key.key_id:
            raise SecretStoreConfigurationError(
                f"secret {record.name!r} is wrapped by unavailable root key {old_root_key_id!r}"
            )

        old_key_aad = _scope_aad(
            tenant_id=record.tenant_id,
            project_id=record.project_id,
            environment=environment,
            name=record.name,
            root_key_id=old_root_key_id,
        )
        try:
            data_key = AESGCM(self._root_key.key).decrypt(
                _unb64(metadata.get("data_key_nonce"), field_name="data_key_nonce"),
                _unb64(metadata.get("wrapped_data_key"), field_name="wrapped_data_key"),
                old_key_aad,
            )
        except InvalidTag as exc:
            raise SecretStoreIntegrityError(
                "encrypted data key failed authenticated verification"
            ) from exc

        new_nonce = os.urandom(12)
        new_key_aad = _scope_aad(
            tenant_id=record.tenant_id,
            project_id=record.project_id,
            environment=environment,
            name=record.name,
            root_key_id=new_root_key.key_id,
        )
        metadata["root_key_id"] = new_root_key.key_id
        metadata["data_key_nonce"] = _b64(new_nonce)
        metadata["wrapped_data_key"] = _b64(
            AESGCM(new_root_key.key).encrypt(new_nonce, data_key, new_key_aad)
        )
        return EncryptedSecretRecord(
            secret_id=record.secret_id,
            tenant_id=record.tenant_id,
            project_id=record.project_id,
            name=record.name,
            encrypted_blob=record.encrypted_blob,
            encryption_key_ref=new_root_key.key_id,
            metadata=metadata,
        )

    def _environment(self, metadata: Mapping[str, Any]) -> Environment:
        if metadata.get("algorithm") != self.algorithm:
            raise SecretStoreIntegrityError("encrypted secret algorithm is unsupported")
        try:
            return Environment(str(metadata["environment"]))
        except (KeyError, ValueError) as exc:
            raise SecretStoreIntegrityError(
                "encrypted secret environment metadata is invalid"
            ) from exc

    def _secret_class(self, metadata: Mapping[str, Any]) -> SecretClass:
        try:
            return SecretClass(str(metadata["secret_class"]))
        except (KeyError, ValueError) as exc:
            raise SecretStoreIntegrityError("encrypted secret class metadata is invalid") from exc

    def _root_key_id(self, record: EncryptedSecretRecord, metadata: Mapping[str, Any]) -> str:
        root_key_id = str(metadata.get("root_key_id", ""))
        if not root_key_id or root_key_id != record.encryption_key_ref:
            raise SecretStoreIntegrityError("encrypted secret root key metadata is inconsistent")
        return root_key_id


class SecretStore:
    """An in-memory store scoped to exactly one environment.

    The production store is the control-plane secrets manager (encrypted at rest,
    access-audited per Doc 10); this in-memory implementation models the same
    contract for the broker and its tests without pretending to capabilities the
    real one has. The load-bearing behaviour is the two refusals in
    :meth:`put`, which keep the store single-environment and project-only.
    """

    def __init__(self, environment: Environment) -> None:
        self.environment = environment
        self._by_key: dict[_Key, StoredSecret] = {}

    def put(self, secret: StoredSecret) -> None:
        """Store a project secret, refusing anything that breaks the firewall.

        A secret of a different environment would put a prod credential within a
        build store's reach; a platform-owned class has no business in a project
        store at all. Both fail closed so the invariant cannot be undermined by a
        mistaken load.
        """
        if secret.environment is not self.environment:
            raise EnvironmentMismatch(
                f"{secret.name!r} is scoped to {secret.environment.value!r}; "
                f"this store holds {self.environment.value!r} secrets only"
            )
        if secret.secret_class is not SecretClass.PROJECT:
            raise PlatformSecretForbidden(
                f"{secret.name!r} is {secret.secret_class.value!r}, a platform-owned "
                "class that may never enter a project store"
            )
        self._by_key[(secret.tenant_id, secret.project_id, secret.name)] = secret

    def names_for_project(self, tenant_id: str, project_id: str) -> list[str]:
        """Names stored for this tenant and project. Persistent stores override this."""
        return [
            name
            for (stored_tenant, stored_project, name) in self._by_key
            if stored_tenant == tenant_id and stored_project == project_id
        ]

    def get(self, tenant_id: str, project_id: str, name: str) -> StoredSecret | None:
        """Return the secret for this tenant/project/name, or ``None``."""
        return self._by_key.get((tenant_id, project_id, name))


class InMemoryEncryptedSecretRepository:
    """Test/local repository for encrypted rows; it never stores plaintext."""

    def __init__(self) -> None:
        self._by_key: dict[_Key, EncryptedSecretRecord] = {}

    def put(self, record: EncryptedSecretRecord) -> None:
        self._by_key[(record.tenant_id, record.project_id, record.name)] = record

    def get(self, tenant_id: str, project_id: str, name: str) -> EncryptedSecretRecord | None:
        return self._by_key.get((tenant_id, project_id, name))

    def list_by_environment_and_root_key(
        self, environment: Environment, root_key_id: str
    ) -> Iterable[EncryptedSecretRecord]:
        return tuple(
            record
            for record in self._by_key.values()
            if record.encryption_key_ref == root_key_id
            and record.metadata.get("environment") == environment.value
        )

    def update_envelope(self, record: EncryptedSecretRecord) -> None:
        self.put(record)


class PersistentSecretStore(SecretStore):
    """Encrypted-at-rest secret store backed by a secrets row repository."""

    def __init__(
        self,
        environment: Environment,
        *,
        repository: EncryptedSecretRepository,
        root_key: RootKey,
    ) -> None:
        super().__init__(environment)
        self._repository = repository
        self._codec = EnvelopeSecretCodec(root_key)

    def put(self, secret: StoredSecret) -> None:
        if secret.environment is not self.environment:
            raise EnvironmentMismatch(
                f"{secret.name!r} is scoped to {secret.environment.value!r}; "
                f"this store holds {self.environment.value!r} secrets only"
            )
        if secret.secret_class is not SecretClass.PROJECT:
            raise PlatformSecretForbidden(
                f"{secret.name!r} is {secret.secret_class.value!r}, a platform-owned "
                "class that may never enter a project store"
            )
        self._repository.put(self._codec.encrypt(secret))

    def names_for_project(self, tenant_id: str, project_id: str) -> list[str]:
        # Durable rows live in the repository. The in-memory index stays empty.
        return [
            record.name
            for record in self._repository.list_by_environment_and_root_key(
                self.environment, self._codec.root_key.key_id
            )
            if record.tenant_id == tenant_id and record.project_id == project_id
        ]

    def get(self, tenant_id: str, project_id: str, name: str) -> StoredSecret | None:
        record = self._repository.get(tenant_id, project_id, name)
        if record is None:
            return None
        secret = self._codec.decrypt(record)
        if secret.environment is not self.environment:
            raise SecretStoreIntegrityError("encrypted secret crossed environment partitions")
        return secret

    def rotate_root_key(self, new_root_key: RootKey) -> None:
        """Re-wrap data keys with ``new_root_key`` without decrypting secret values."""

        old_root_key = self._codec.root_key
        for record in self._repository.list_by_environment_and_root_key(
            self.environment, old_root_key.key_id
        ):
            self._repository.update_envelope(self._codec.rewrap_data_key(record, new_root_key))
        self._codec.root_key = new_root_key


class PostgresEncryptedSecretRepository:
    """Direct psycopg repository for ``packages/store``'s ``secrets`` table."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    @classmethod
    def connect(cls, dsn: str) -> PostgresEncryptedSecretRepository:
        import psycopg
        from loopit_store.migrate import pin_loopit_schema
        from psycopg.rows import dict_row

        conn = psycopg.connect(dsn, row_factory=dict_row)
        pin_loopit_schema(conn)
        return cls(conn)

    def put(self, record: EncryptedSecretRecord) -> None:
        from psycopg.types.json import Jsonb

        self._conn.execute(
            """
            INSERT INTO secrets (
                secret_id, tenant_id, project_id, name, encrypted_blob,
                encryption_key_ref, metadata
            ) VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, project_id, name) DO UPDATE
            SET encrypted_blob = EXCLUDED.encrypted_blob,
                encryption_key_ref = EXCLUDED.encryption_key_ref,
                metadata = EXCLUDED.metadata,
                revoked_at = NULL,
                rotated_at = now()
            """,
            (
                record.secret_id,
                record.tenant_id,
                record.project_id,
                record.name,
                record.encrypted_blob,
                record.encryption_key_ref,
                Jsonb(dict(record.metadata)),
            ),
        )

    def get(self, tenant_id: str, project_id: str, name: str) -> EncryptedSecretRecord | None:
        row = self._conn.execute(
            """
            SELECT secret_id, tenant_id, project_id, name, encrypted_blob,
                   encryption_key_ref, metadata
            FROM secrets
            WHERE tenant_id = %s AND project_id = %s AND name = %s AND revoked_at IS NULL
            """,
            (tenant_id, project_id, name),
        ).fetchone()
        return self._record(row) if row is not None else None

    def list_by_environment_and_root_key(
        self, environment: Environment, root_key_id: str
    ) -> Iterable[EncryptedSecretRecord]:
        rows = self._conn.execute(
            """
            SELECT secret_id, tenant_id, project_id, name, encrypted_blob,
                   encryption_key_ref, metadata
            FROM secrets
            WHERE encryption_key_ref = %s
              AND metadata->>'environment' = %s
              AND revoked_at IS NULL
            """,
            (root_key_id, environment.value),
        ).fetchall()
        return tuple(self._record(row) for row in rows)

    def update_envelope(self, record: EncryptedSecretRecord) -> None:
        from psycopg.types.json import Jsonb

        self._conn.execute(
            """
            UPDATE secrets
            SET encryption_key_ref = %s, metadata = %s, rotated_at = now()
            WHERE secret_id = %s
            """,
            (record.encryption_key_ref, Jsonb(dict(record.metadata)), record.secret_id),
        )

    def _record(self, row: Mapping[str, Any]) -> EncryptedSecretRecord:
        encrypted_blob = row["encrypted_blob"]
        if isinstance(encrypted_blob, memoryview):
            blob = encrypted_blob.tobytes()
        else:
            blob = bytes(cast(bytes, encrypted_blob))
        return EncryptedSecretRecord(
            secret_id=str(row["secret_id"]),
            tenant_id=str(row["tenant_id"]),
            project_id=str(row["project_id"]),
            name=str(row["name"]),
            encrypted_blob=blob,
            encryption_key_ref=str(row["encryption_key_ref"]),
            metadata=cast(MutableMapping[str, Any], row["metadata"]),
        )


class PostgresSecretStore(PersistentSecretStore):
    """Encrypted persistent store using the shared Postgres ``secrets`` table."""

    @classmethod
    def connect(
        cls,
        environment: Environment,
        *,
        dsn: str,
        root_key: RootKey | None = None,
    ) -> PostgresSecretStore:
        return cls(
            environment,
            repository=PostgresEncryptedSecretRepository.connect(dsn),
            root_key=load_root_key_from_env() if root_key is None else root_key,
        )


class VaultSecretStore(SecretStore):
    """Future Vault adapter for the same broker-facing store interface.

    Migration path: keep ``SecretsBroker`` and lease semantics unchanged, then
    implement this adapter with Vault KV v2 for encrypted payload storage and
    transit for root/data-key wrapping. The Postgres metadata shape above
    already records scope and key ids needed to migrate rows without broadening
    sandbox access. No Vault dependency is imported until that cut-over.
    """

    def put(self, secret: StoredSecret) -> None:
        raise NotImplementedError("VaultSecretStore writes are deferred until the Vault migration")

    def get(self, tenant_id: str, project_id: str, name: str) -> StoredSecret | None:
        raise NotImplementedError("VaultSecretStore reads are deferred until the Vault migration")


def store_from_env(environment: Environment, env: Mapping[str, str] | None = None) -> SecretStore:
    """Return Postgres encrypted storage when configured; otherwise in-memory."""

    source = os.environ if env is None else env
    dsn = source.get("LOOPIT_SECRETS_POSTGRES_DSN") or source.get("LOOPIT_STORE_DSN")
    if not dsn:
        return SecretStore(environment)
    return PostgresSecretStore.connect(
        environment, dsn=dsn, root_key=load_root_key_from_env(source)
    )
