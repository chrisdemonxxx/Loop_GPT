from __future__ import annotations

import os
from datetime import timedelta

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_provision import (
    DATABASE_URL_SECRET,
    JWT_SECRET_SECRET,
    ColumnSpec,
    DatabaseProvisionRequest,
    GeneratedAppJwtIssuer,
    GeneratedAppSecretManager,
    InMemoryDatabaseProvisioner,
    InMemoryStorageProvisioner,
    Migration,
    MigrationConflict,
    PsycopgDatabaseProvisioner,
    SeedData,
    StorageCredentialIssuer,
    TableSpec,
    postgres_claims_payload,
    set_local_claims_sql,
)
from loopit_secrets import (
    Environment,
    SecretClass,
    SecretsBroker,
    SecretStore,
    SecretValue,
    StepContext,
    StoredSecret,
)

TENANT = "tenant_alpha"
PROJECT = "project_gamma"


def _secret(marker: str) -> str:
    return "value" + "_" + marker + "_" + "x" * 24


def _tasks() -> TableSpec:
    return TableSpec(
        name="tasks",
        columns=(ColumnSpec("title", "text", nullable=False),),
        access="owner",
    )


def test_project_schemas_and_roles_are_isolated() -> None:
    provisioner = InMemoryDatabaseProvisioner()

    first = provisioner.provision(
        DatabaseProvisionRequest(tenant_id=TENANT, project_id=PROJECT, tables=(_tasks(),))
    )
    second = provisioner.provision(
        DatabaseProvisionRequest(tenant_id=TENANT, project_id="project_delta", tables=(_tasks(),))
    )

    assert first.names.schema != second.names.schema
    provisioner.assert_role_can_only_access_schema(first.names.app_role, first.names.schema)
    with pytest.raises(PermissionError):
        provisioner.assert_role_can_only_access_schema(first.names.app_role, second.names.schema)


def test_post_provision_verifier_catches_table_without_rls() -> None:
    provisioner = InMemoryDatabaseProvisioner()
    database = provisioner.provision(
        DatabaseProvisionRequest(tenant_id=TENANT, project_id=PROJECT, tables=(_tasks(),))
    )

    provisioner.inject_unprotected_table(database.names.schema, "unsafe")
    result = provisioner.verify_schema(database.names.schema)

    assert "unsafe" in result.unprotected
    with pytest.raises(ValueError, match="unsafe"):
        result.require_full_coverage()


def test_migration_failure_rolls_back_partial_schema_changes() -> None:
    provisioner = InMemoryDatabaseProvisioner()
    schema = "p_" + "a" * 24
    bad = Migration(
        migration_id="0002_bad",
        sql=f'CREATE TABLE "{schema}"."bad" (id uuid); RAISE_MIGRATION_FAILURE;',
    )

    with pytest.raises(Exception, match="fake migration failure"):
        provisioner.provision(
            DatabaseProvisionRequest(
                tenant_id=TENANT, project_id=PROJECT, tables=(), migrations=(bad,)
            )
        )

    database = provisioner.provision(
        DatabaseProvisionRequest(tenant_id=TENANT, project_id=PROJECT, tables=(_tasks(),))
    )
    assert "bad" not in provisioner.verify_schema(database.names.schema).tables


def test_migrations_are_idempotent_on_retry_and_conflict_on_drift() -> None:
    provisioner = InMemoryDatabaseProvisioner()
    request = DatabaseProvisionRequest(tenant_id=TENANT, project_id=PROJECT, tables=(_tasks(),))

    first = provisioner.provision(request)
    second = provisioner.provision(request)

    assert first.applied_migrations == ("0001_generated_tables",)
    assert second.applied_migrations == ()
    drift = Migration("0001_generated_tables", 'CREATE TABLE "p_bad"."x" (id uuid);')
    with pytest.raises(MigrationConflict):
        provisioner.provision(
            DatabaseProvisionRequest(
                tenant_id=TENANT, project_id=PROJECT, tables=(), migrations=(drift,)
            )
        )


def test_seed_data_is_recorded_after_successful_migrations() -> None:
    provisioner = InMemoryDatabaseProvisioner()
    seed = SeedData('INSERT INTO "tasks" ("title") VALUES (%s)', ("hello",))

    provisioner.provision(
        DatabaseProvisionRequest(
            tenant_id=TENANT, project_id=PROJECT, tables=(_tasks(),), seed_data=(seed,)
        )
    )

    assert provisioner.seeded == [seed]


def test_generated_jwt_and_postgres_claims_match_stack_template() -> None:
    issuer = GeneratedAppJwtIssuer(secret=_secret("jwt"))
    token = issuer.issue_token(
        user_id="018f6d90-10b9-7aa7-8fd6-111111111111",
        org_id="018f6d90-10b9-7aa7-8fd6-222222222222",
        now=100,
    )

    payload = issuer.verify_token(token, now=101)

    assert payload["sub"] == "018f6d90-10b9-7aa7-8fd6-111111111111"
    assert payload["org_id"] == "018f6d90-10b9-7aa7-8fd6-222222222222"
    assert postgres_claims_payload(user_id="u", org_id="o") == '{"org_id":"o","sub":"u"}'
    assert set_local_claims_sql()[0] == "SELECT set_config('request.jwt.claims', $1, true)"


def test_storage_prefix_isolation() -> None:
    storage = InMemoryStorageProvisioner()
    first = storage.provision_bucket(TENANT, PROJECT)
    second = storage.provision_bucket(TENANT, "project_delta")

    storage.put_object(first, "uploads/a.txt", b"alpha")

    assert first.prefix != second.prefix
    assert storage.get_object(first, "uploads/a.txt") == b"alpha"
    with pytest.raises(Exception):
        storage.get_object(second, "uploads/a.txt")
    with pytest.raises(Exception):
        storage.put_object(first, "../escape.txt", b"nope")


def test_generated_credentials_are_leased_and_not_rendered_in_outputs() -> None:
    store = SecretStore(Environment.PROD)
    audit = InMemoryAuditSink()
    broker = SecretsBroker(store, audit=audit)
    manager = GeneratedAppSecretManager(store, broker)
    provisioner = InMemoryDatabaseProvisioner()
    database = provisioner.provision(
        DatabaseProvisionRequest(tenant_id=TENANT, project_id=PROJECT, tables=(_tasks(),))
    )
    database_url = _secret("database_url")
    jwt_secret = _secret("jwt_secret")

    manager.register_database_url(database, SecretValue(database_url))
    manager.register_jwt_secret(database, SecretValue(jwt_secret))
    leases = manager.issue_runtime_leases(
        StepContext(
            run_id="run_1",
            step_id="deploy",
            tenant_id=TENANT,
            project_id=PROJECT,
            declared_secrets=frozenset({DATABASE_URL_SECRET, JWT_SECRET_SECRET}),
        )
    )

    rendered = f"{database!r}\n{leases!r}\n{audit.events!r}"
    assert database_url not in rendered
    assert jwt_secret not in rendered


def test_storage_credentials_are_jit_leased() -> None:
    store = SecretStore(Environment.PROD)
    access_key = _secret("access")
    secret_key = _secret("secret")
    for name, value in (
        (StorageCredentialIssuer.access_key_name, access_key),
        (StorageCredentialIssuer.secret_key_name, secret_key),
    ):
        store.put(
            StoredSecret(
                name=name,
                environment=Environment.PROD,
                secret_class=SecretClass.PROJECT,
                tenant_id=TENANT,
                project_id=PROJECT,
                value=SecretValue(value),
            )
        )
    broker = SecretsBroker(store, audit=InMemoryAuditSink())
    issuer = StorageCredentialIssuer(broker, ttl=timedelta(seconds=30))

    leases = issuer.issue(
        StepContext(
            run_id="run_1",
            step_id="storage",
            tenant_id=TENANT,
            project_id=PROJECT,
            declared_secrets=frozenset(
                {
                    StorageCredentialIssuer.access_key_name,
                    StorageCredentialIssuer.secret_key_name,
                }
            ),
        )
    )

    rendered = repr(leases)
    assert access_key not in rendered
    assert secret_key not in rendered
    assert tuple(value.reveal() for value in issuer.reveal_for_step(leases)) == (
        access_key,
        secret_key,
    )


@pytest.mark.skipif(not os.environ.get("LOOPIT_TEST_DSN"), reason="LOOPIT_TEST_DSN is unset")
def test_live_postgres_provisioning_smoke() -> None:
    provisioner = PsycopgDatabaseProvisioner(os.environ["LOOPIT_TEST_DSN"])
    database = provisioner.provision(
        DatabaseProvisionRequest(
            tenant_id=TENANT,
            project_id="project_live_smoke",
            tables=(_tasks(),),
            app_password=_secret("app_password"),
        )
    )

    assert database.verified_tables == ("tasks",)
