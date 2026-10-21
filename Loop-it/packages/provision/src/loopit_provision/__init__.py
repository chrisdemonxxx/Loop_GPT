"""Schema provisioning for generated apps, with row-level security built in.

Public surface is deliberately small: describe tables with :class:`TableSpec`,
call :func:`emit_migration`, get SQL that is secure by construction. There is no
exported way to create a table without RLS (I9).
"""

from __future__ import annotations

from .auth import GeneratedAppJwtIssuer, JwtError, postgres_claims_payload, set_local_claims_sql
from .database import (
    DatabaseProvisioner,
    DatabaseProvisionRequest,
    InMemoryDatabaseProvisioner,
    Migration,
    MigrationConflict,
    PgCatalogRlsVerifier,
    ProjectDatabaseNames,
    ProvisionedDatabase,
    ProvisioningError,
    PsycopgDatabaseProvisioner,
    RlsCatalogVerifier,
    RlsVerificationResult,
    SeedData,
    generated_table_migration,
    project_database_names,
    scoped_tables,
)
from .identifiers import IdentifierError, quote_identifier, validate_identifier
from .rls import (
    APP_ROLE,
    CURRENT_TENANT_EXPR,
    CURRENT_USER_EXPR,
    AccessModel,
    RlsError,
    RlsPolicy,
    assert_secured,
    enable_rls_statements,
    generate_policies,
    ownership_predicate,
)
from .schema import COLUMN_TYPES, ColumnSpec, TableSpec, emit_migration, emit_table
from .secrets import (
    DATABASE_URL_SECRET,
    JWT_SECRET_SECRET,
    GeneratedAppSecretLeases,
    GeneratedAppSecretManager,
)
from .storage import (
    InMemoryStorageProvisioner,
    StorageBucket,
    StorageCredentialIssuer,
    StorageCredentialLeases,
    StorageError,
    StorageObject,
    StorageProvisioner,
)
from .tool import (
    MigrationRunner,
    ProvisionOutcome,
    SpecError,
    parse_table_spec,
    plan_migration,
    provision,
)

__all__ = [
    "APP_ROLE",
    "COLUMN_TYPES",
    "CURRENT_TENANT_EXPR",
    "CURRENT_USER_EXPR",
    "DATABASE_URL_SECRET",
    "JWT_SECRET_SECRET",
    "AccessModel",
    "ColumnSpec",
    "DatabaseProvisionRequest",
    "DatabaseProvisioner",
    "GeneratedAppJwtIssuer",
    "GeneratedAppSecretLeases",
    "GeneratedAppSecretManager",
    "IdentifierError",
    "InMemoryDatabaseProvisioner",
    "InMemoryStorageProvisioner",
    "JwtError",
    "Migration",
    "MigrationConflict",
    "MigrationRunner",
    "PgCatalogRlsVerifier",
    "ProjectDatabaseNames",
    "ProvisionOutcome",
    "ProvisionedDatabase",
    "ProvisioningError",
    "PsycopgDatabaseProvisioner",
    "RlsCatalogVerifier",
    "RlsError",
    "RlsPolicy",
    "RlsVerificationResult",
    "SeedData",
    "SpecError",
    "StorageBucket",
    "StorageCredentialIssuer",
    "StorageCredentialLeases",
    "StorageError",
    "StorageObject",
    "StorageProvisioner",
    "TableSpec",
    "assert_secured",
    "emit_migration",
    "emit_table",
    "enable_rls_statements",
    "generate_policies",
    "generated_table_migration",
    "ownership_predicate",
    "parse_table_spec",
    "plan_migration",
    "postgres_claims_payload",
    "project_database_names",
    "provision",
    "quote_identifier",
    "scoped_tables",
    "set_local_claims_sql",
    "validate_identifier",
]
