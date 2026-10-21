"""Generated-app credential registration and JIT leasing."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from loopit_secrets import (
    Environment,
    Lease,
    SecretClass,
    SecretsBroker,
    SecretStore,
    SecretValue,
    StepContext,
    StoredSecret,
)

from .database import ProvisionedDatabase

DATABASE_URL_SECRET = "GENERATED_DATABASE_URL"  # noqa: S105 - secret name, not value
JWT_SECRET_SECRET = "GENERATED_JWT_SECRET"  # noqa: S105 - secret name, not value


@dataclass(frozen=True, slots=True)
class GeneratedAppSecretLeases:
    """Lease handles for generated-app runtime secrets; contains no plaintext."""

    database_url: Lease
    jwt_secret: Lease


class GeneratedAppSecretManager:
    """Persists generated-app credentials and releases them only as JIT leases."""

    def __init__(self, store: SecretStore, broker: SecretsBroker) -> None:
        if store.environment is not broker.environment:
            raise ValueError("secret store and broker must serve the same environment")
        self._store = store
        self._broker = broker

    @property
    def environment(self) -> Environment:
        return self._store.environment

    def register_database_url(
        self, database: ProvisionedDatabase, database_url: SecretValue
    ) -> None:
        self._store.put(
            StoredSecret(
                name=DATABASE_URL_SECRET,
                environment=self.environment,
                secret_class=SecretClass.PROJECT,
                tenant_id=database.tenant_id,
                project_id=database.project_id,
                value=database_url,
            )
        )

    def register_jwt_secret(self, database: ProvisionedDatabase, jwt_secret: SecretValue) -> None:
        self._store.put(
            StoredSecret(
                name=JWT_SECRET_SECRET,
                environment=self.environment,
                secret_class=SecretClass.PROJECT,
                tenant_id=database.tenant_id,
                project_id=database.project_id,
                value=jwt_secret,
            )
        )

    def issue_runtime_leases(
        self,
        context: StepContext,
        *,
        ttl: timedelta = timedelta(minutes=5),
    ) -> GeneratedAppSecretLeases:
        return GeneratedAppSecretLeases(
            database_url=self._broker.issue(context, DATABASE_URL_SECRET, ttl=ttl),
            jwt_secret=self._broker.issue(context, JWT_SECRET_SECRET, ttl=ttl),
        )


__all__ = [
    "DATABASE_URL_SECRET",
    "JWT_SECRET_SECRET",
    "GeneratedAppSecretLeases",
    "GeneratedAppSecretManager",
]
