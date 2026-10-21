from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, cast

from .models import AuthUser, Membership, Org, Role, now_utc


@dataclass(frozen=True, slots=True)
class PasswordResetToken:
    token: str
    user_id: str
    expires_at: datetime
    used: bool = False


class InMemoryAuthRepository:
    def __init__(self) -> None:
        self._users: dict[str, AuthUser] = {}
        self._email_index: dict[tuple[str, str], str] = {}
        self._passwords: dict[str, str] = {}
        self._orgs: dict[str, Org] = {}
        self._memberships: dict[tuple[str, str], Membership] = {}
        self._failures: dict[str, tuple[int, datetime | None]] = {}
        self._reset_tokens: dict[str, PasswordResetToken] = {}

    def create_org(self, *, name: str, org_id: str | None = None) -> Org:
        oid = org_id or f"org_{secrets.token_hex(6)}"
        if oid in self._orgs:
            raise ValueError("org already exists")
        org = Org(org_id=oid, tenant_id=oid, name=name)
        self._orgs[oid] = org
        return org

    def ensure_org(self, org_id: str) -> bool:
        """Idempotent tenant/org provisioning for identity-bridge actors.

        A parent platform mints identity tokens for orgs that never registered
        here; their tenant row must exist before the first audit write or the
        FK on audit_log_tenant_id rejects the run. Returns True when the org
        was created by this call (first sight), False when it already existed.
        """
        if org_id in self._orgs:
            return False
        self._orgs[org_id] = Org(org_id=org_id, tenant_id=org_id, name=org_id)
        return True

    def ensure_user(self, *, user_id: str, tenant_id: str) -> None:
        """Idempotent user provisioning for identity-bridge actors.

        The parent mints identity tokens whose subject is a parent-side user
        id; projects.owner_user_id references users(user_id), so the row must
        exist before the first project insert.
        """
        self._users.setdefault(user_id, AuthUser(user_id=user_id, tenant_id=tenant_id, email=f"{user_id}@bridge.local", display_name=None))

    def get_org(self, org_id: str) -> Org | None:
        return self._orgs.get(org_id)

    def create_user(
        self,
        *,
        email: str,
        password_hash: str,
        display_name: str | None,
        org_id: str,
        role: Role = "owner",
    ) -> AuthUser:
        normalized = email.strip().lower()
        if (org_id, normalized) in self._email_index:
            raise ValueError("email already registered")
        user = AuthUser(
            user_id=f"usr_{secrets.token_hex(8)}",
            tenant_id=org_id,
            email=normalized,
            display_name=display_name,
        )
        self._users[user.user_id] = user
        self._email_index[(org_id, normalized)] = user.user_id
        self._passwords[user.user_id] = password_hash
        self.add_membership(user_id=user.user_id, org_id=org_id, role=role)
        return user

    def find_user_by_email(self, *, email: str, org_id: str) -> AuthUser | None:
        user_id = self._email_index.get((org_id, email.strip().lower()))
        return self._users.get(user_id) if user_id else None

    def get_user(self, user_id: str) -> AuthUser | None:
        return self._users.get(user_id)

    def password_hash_for(self, user_id: str) -> str | None:
        return self._passwords.get(user_id)

    def add_membership(self, *, user_id: str, org_id: str, role: Role) -> Membership:
        membership = Membership(user_id=user_id, org_id=org_id, tenant_id=org_id, role=role)
        self._memberships[(user_id, org_id)] = membership
        return membership

    def membership(self, *, user_id: str, org_id: str) -> Membership | None:
        return self._memberships.get((user_id, org_id))

    def memberships_for_user(self, user_id: str) -> tuple[Membership, ...]:
        return tuple(m for (uid, _), m in self._memberships.items() if uid == user_id)

    def failure_state(self, user_id: str) -> tuple[int, datetime | None]:
        return self._failures.get(user_id, (0, None))

    def record_failure(self, user_id: str, *, lock_until: datetime | None) -> None:
        count, _ = self.failure_state(user_id)
        self._failures[user_id] = (count + 1, lock_until)

    def clear_failures(self, user_id: str) -> None:
        self._failures.pop(user_id, None)

    def create_reset_token(self, *, user_id: str, ttl: timedelta) -> PasswordResetToken:
        token = secrets.token_urlsafe(32)
        record = PasswordResetToken(token=token, user_id=user_id, expires_at=now_utc() + ttl)
        self._reset_tokens[token] = record
        return record


class PostgresAuthRepository:
    """Postgres auth repository layered on the loopit-store control-plane schema."""

    def __init__(self, conn: Any, *, ensure_schema: bool = True) -> None:
        self._conn = conn
        if ensure_schema:
            self.ensure_schema()

    def ensure_schema(self) -> None:
        # Every mutating method in this repository must commit: without it the
        # writes live only in this connection's implicit transaction, invisible
        # to other connections (the audit sink, the quota store) and lost on
        # restart. Error paths roll back so the connection stays usable.
        execute = self._conn.execute
        try:
            execute(
                """
                CREATE TABLE IF NOT EXISTS auth_credentials (
                    user_id text PRIMARY KEY REFERENCES users (user_id),
                    password_hash text NOT NULL,
                    failed_attempts integer NOT NULL DEFAULT 0,
                    locked_until timestamptz
                )
                """
            )
            execute(
                """
                CREATE TABLE IF NOT EXISTS org_memberships (
                    org_id text NOT NULL REFERENCES orgs (org_id),
                    user_id text NOT NULL REFERENCES users (user_id),
                    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
                    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
                    created_at timestamptz NOT NULL DEFAULT now(),
                    PRIMARY KEY (org_id, user_id)
                )
                """
            )
            execute(
                """
                CREATE TABLE IF NOT EXISTS password_reset_tokens (
                    token text PRIMARY KEY,
                    user_id text NOT NULL REFERENCES users (user_id),
                    expires_at timestamptz NOT NULL,
                    used boolean NOT NULL DEFAULT false
                )
                """
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def create_org(self, *, name: str, org_id: str | None = None) -> Org:
        oid = org_id or f"org_{secrets.token_hex(6)}"
        execute = self._conn.execute
        try:
            execute("INSERT INTO tenants (tenant_id, name) VALUES (%s, %s)", (oid, name))
            row = execute(
                "INSERT INTO orgs (org_id, tenant_id, name) VALUES (%s, %s, %s) RETURNING *",
                (oid, oid, name),
            ).fetchone()
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        return Org(
            org_id=str(row["org_id"]), tenant_id=str(row["tenant_id"]), name=str(row["name"])
        )

    def ensure_org(self, org_id: str) -> bool:
        """Idempotent tenant/org provisioning for identity-bridge actors.

        See InMemoryAuthRepository.ensure_org; the ON CONFLICT clauses make
        repeated first-sight calls a no-op. Returns True on first sight.
        """
        execute = self._conn.execute
        try:
            row = execute(
                "INSERT INTO tenants (tenant_id, name) VALUES (%s, %s) "
                "ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id",
                (org_id, org_id),
            ).fetchone()
            execute(
                "INSERT INTO orgs (org_id, tenant_id, name) VALUES (%s, %s, %s) "
                "ON CONFLICT (org_id) DO NOTHING",
                (org_id, org_id, org_id),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        return row is not None

    def ensure_user(self, *, user_id: str, tenant_id: str) -> None:
        """Idempotent user provisioning for identity-bridge actors.

        See InMemoryAuthRepository.ensure_user; a bridge-local placeholder
        email keeps the (tenant_id, email) unique constraint satisfiable.
        """
        execute = self._conn.execute
        try:
            execute(
                "INSERT INTO users (user_id, tenant_id, email, display_name) "
                "VALUES (%s, %s, %s, NULL) ON CONFLICT (user_id) DO NOTHING",
                (user_id, tenant_id, f"{user_id}@bridge.local"),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def get_org(self, org_id: str) -> Org | None:
        row = self._conn.execute("SELECT * FROM orgs WHERE org_id = %s", (org_id,)).fetchone()
        if row is None:
            return None
        return Org(
            org_id=str(row["org_id"]), tenant_id=str(row["tenant_id"]), name=str(row["name"])
        )

    def create_user(
        self,
        *,
        email: str,
        password_hash: str,
        display_name: str | None,
        org_id: str,
        role: Role = "owner",
    ) -> AuthUser:
        normalized = email.strip().lower()
        user_id = f"usr_{secrets.token_hex(8)}"
        execute = self._conn.execute
        try:
            row = execute(
                """
                INSERT INTO users (user_id, tenant_id, email, display_name)
                VALUES (%s, %s, %s, %s) RETURNING *
                """,
                (user_id, org_id, normalized, display_name),
            ).fetchone()
            execute(
                "INSERT INTO auth_credentials (user_id, password_hash) VALUES (%s, %s)",
                (user_id, password_hash),
            )
            self.add_membership(user_id=user_id, org_id=org_id, role=role)
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        return AuthUser(
            user_id=str(row["user_id"]),
            tenant_id=str(row["tenant_id"]),
            email=str(row["email"]),
            display_name=row["display_name"],
        )

    def find_user_by_email(self, *, email: str, org_id: str) -> AuthUser | None:
        row = self._conn.execute(
            "SELECT * FROM users WHERE tenant_id = %s AND email = %s",
            (org_id, email.strip().lower()),
        ).fetchone()
        return self._user(row) if row else None

    def get_user(self, user_id: str) -> AuthUser | None:
        row = self._conn.execute("SELECT * FROM users WHERE user_id = %s", (user_id,)).fetchone()
        return self._user(row) if row else None

    def password_hash_for(self, user_id: str) -> str | None:
        row = self._conn.execute(
            "SELECT password_hash FROM auth_credentials WHERE user_id = %s", (user_id,)
        ).fetchone()
        return str(row["password_hash"]) if row else None

    def add_membership(self, *, user_id: str, org_id: str, role: Role) -> Membership:
        try:
            row = self._conn.execute(
                """
                INSERT INTO org_memberships (org_id, user_id, tenant_id, role)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
                RETURNING *
                """,
                (org_id, user_id, org_id, role),
            ).fetchone()
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        return self._membership(row)

    def membership(self, *, user_id: str, org_id: str) -> Membership | None:
        row = self._conn.execute(
            "SELECT * FROM org_memberships WHERE user_id = %s AND org_id = %s",
            (user_id, org_id),
        ).fetchone()
        return self._membership(row) if row else None

    def memberships_for_user(self, user_id: str) -> tuple[Membership, ...]:
        rows = self._conn.execute(
            "SELECT * FROM org_memberships WHERE user_id = %s ORDER BY created_at", (user_id,)
        ).fetchall()
        return tuple(self._membership(row) for row in rows)

    def failure_state(self, user_id: str) -> tuple[int, datetime | None]:
        row = self._conn.execute(
            "SELECT failed_attempts, locked_until FROM auth_credentials WHERE user_id = %s",
            (user_id,),
        ).fetchone()
        return (int(row["failed_attempts"]), row["locked_until"]) if row else (0, None)

    def record_failure(self, user_id: str, *, lock_until: datetime | None) -> None:
        try:
            self._conn.execute(
                """
                UPDATE auth_credentials
                SET failed_attempts = failed_attempts + 1, locked_until = %s
                WHERE user_id = %s
                """,
                (lock_until, user_id),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def clear_failures(self, user_id: str) -> None:
        try:
            self._conn.execute(
                """
                UPDATE auth_credentials
                SET failed_attempts = 0, locked_until = NULL
                WHERE user_id = %s
                """,
                (user_id,),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def create_reset_token(self, *, user_id: str, ttl: timedelta) -> PasswordResetToken:
        record = PasswordResetToken(
            token=secrets.token_urlsafe(32), user_id=user_id, expires_at=now_utc() + ttl
        )
        try:
            self._conn.execute(
                """
                INSERT INTO password_reset_tokens (token, user_id, expires_at, used)
                VALUES (%s, %s, %s, %s)
                """,
                (record.token, record.user_id, record.expires_at, record.used),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        return record

    @staticmethod
    def _user(row: object) -> AuthUser:
        values = cast(Any, row)
        return AuthUser(
            user_id=str(values["user_id"]),
            tenant_id=str(values["tenant_id"]),
            email=str(values["email"]),
            display_name=values["display_name"],
        )

    @staticmethod
    def _membership(row: object) -> Membership:
        values = cast(Any, row)
        return Membership(
            user_id=str(values["user_id"]),
            org_id=str(values["org_id"]),
            tenant_id=str(values["tenant_id"]),
            role=cast(Role, values["role"]),
            created_at=values["created_at"],
        )
