"""Encrypted persistent store behaviour that does not require Postgres."""

from __future__ import annotations

import base64
import json
from dataclasses import replace

import pytest
from loopit_secrets import (
    EnvelopeSecretCodec,
    Environment,
    InMemoryEncryptedSecretRepository,
    PersistentSecretStore,
    RootKey,
    SecretClass,
    SecretStoreConfigurationError,
    SecretStoreIntegrityError,
    SecretValue,
    StoredSecret,
    VaultSecretStore,
    load_root_key_from_env,
)

from .conftest import PROJECT, SECRET_NAME, TENANT, fake_value


def _root_key(key_id: str = "root-a", *, byte: int = 1) -> RootKey:
    return RootKey(key_id=key_id, key=bytes([byte]) * 32)


def _stored(value: str | None = None) -> StoredSecret:
    return StoredSecret(
        name=SECRET_NAME,
        environment=Environment.BUILD,
        secret_class=SecretClass.PROJECT,
        tenant_id=TENANT,
        project_id=PROJECT,
        value=SecretValue(value or fake_value("persistent")),
    )


def test_encrypted_store_round_trips_without_storing_plaintext() -> None:
    repository = InMemoryEncryptedSecretRepository()
    store = PersistentSecretStore(Environment.BUILD, repository=repository, root_key=_root_key())
    secret = _stored()

    store.put(secret)

    loaded = store.get(TENANT, PROJECT, SECRET_NAME)
    assert loaded is not None
    assert loaded.value.reveal() == secret.value.reveal()
    record = repository.get(TENANT, PROJECT, SECRET_NAME)
    assert record is not None
    serialised_record = repr(record) + json.dumps(dict(record.metadata), sort_keys=True)
    assert secret.value.reveal() not in serialised_record
    assert secret.value.reveal().encode() not in record.encrypted_blob


def test_aad_rejects_scope_confusion_replay() -> None:
    codec = EnvelopeSecretCodec(_root_key())
    record = codec.encrypt(_stored())
    replayed_elsewhere = replace(record, project_id="project_elsewhere")
    replayed_env = replace(record, metadata={**dict(record.metadata), "environment": "prod"})

    with pytest.raises(SecretStoreIntegrityError):
        codec.decrypt(replayed_elsewhere)
    with pytest.raises(SecretStoreIntegrityError):
        codec.decrypt(replayed_env)


def test_missing_or_short_root_key_refuses_startup() -> None:
    with pytest.raises(SecretStoreConfigurationError):
        load_root_key_from_env({})

    short_key = base64.b64encode(b"too-short").decode("ascii")
    with pytest.raises(SecretStoreConfigurationError):
        load_root_key_from_env({"LOOPIT_SECRETS_ROOT_KEY": short_key})

    with pytest.raises(SecretStoreConfigurationError):
        load_root_key_from_env({"LOOPIT_SECRETS_ROOT_KEY": "replace-with-local-dev-only-key"})


def test_root_key_rotation_preserves_readability_without_reencrypting_secret_blob() -> None:
    repository = InMemoryEncryptedSecretRepository()
    store = PersistentSecretStore(
        Environment.BUILD, repository=repository, root_key=_root_key("root-a", byte=1)
    )
    secret = _stored(fake_value("rotation"))
    store.put(secret)
    before = repository.get(TENANT, PROJECT, SECRET_NAME)
    assert before is not None

    store.rotate_root_key(_root_key("root-b", byte=2))

    after = repository.get(TENANT, PROJECT, SECRET_NAME)
    assert after is not None
    assert after.encrypted_blob == before.encrypted_blob
    assert after.encryption_key_ref == "root-b"
    assert after.metadata["wrapped_data_key"] != before.metadata["wrapped_data_key"]
    assert store.get(TENANT, PROJECT, SECRET_NAME).value.reveal() == secret.value.reveal()  # type: ignore[union-attr]


def test_vault_store_adapter_is_an_explicit_stub() -> None:
    store = VaultSecretStore(Environment.BUILD)
    with pytest.raises(NotImplementedError):
        store.put(_stored())
    with pytest.raises(NotImplementedError):
        store.get(TENANT, PROJECT, SECRET_NAME)
