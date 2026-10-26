"""Sync psycopg implementations of the control-plane repository protocols."""

from __future__ import annotations

import functools
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, cast

import psycopg
from loopit_agent_core.audit import AuditEvent
from psycopg import Connection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .models import (
    AuditRecord,
    CheckpointRecord,
    LeaseRecord,
    ProjectRecord,
    QuotaEntry,
    RunBudget,
    RunEvent,
    RunRecord,
    RunStatus,
    audit_row_hash,
    now_utc,
)


def connect(dsn: str) -> Connection[dict[str, Any]]:
    """Open a store connection pinned to the loopit schema.

    The DSN should also set ``search_path=loopit``. This session setting covers
    callers that share Loop-GPT's database URL and would otherwise resolve
    unqualified names in ``public``.
    """

    from .migrate import pin_loopit_schema

    conn = psycopg.connect(dsn, row_factory=dict_row)
    pin_loopit_schema(conn)
    return conn


def _dt(value: object) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _run(row: Mapping[str, Any]) -> RunRecord:
    return RunRecord(
        run_id=str(row["run_id"]),
        tenant_id=str(row["tenant_id"]),
        project_id=str(row["project_id"]),
        prompt=str(row["prompt"]),
        difficulty=str(row["difficulty"]),
        status=cast(RunStatus, row["status"]),
        budget=RunBudget(
            max_iterations=int(row["budget_max_iterations"]),
            max_tokens=cast(int | None, row["budget_max_tokens"]),
            max_wall_clock_seconds=cast(int | None, row["budget_max_wall_clock_seconds"]),
            max_credits=cast(Decimal | None, row["budget_max_credits"]),
        ),
        iterations=int(row["iterations"]),
        cost_credits=cast(Decimal, row["cost_credits"]),
        summary=str(row["summary"]),
        created_at=_dt(row["created_at"]),
        started_at=_dt(row["started_at"]) if row["started_at"] is not None else None,
        finished_at=_dt(row["finished_at"]) if row["finished_at"] is not None else None,
    )


def _project(row: Mapping[str, Any]) -> ProjectRecord:
    return ProjectRecord(
        project_id=str(row["project_id"]),
        tenant_id=str(row["tenant_id"]),
        owner_user_id=cast(str | None, row["owner_user_id"]),
        name=str(row["name"]),
        stack=str(row["stack"]),
        current_checkpoint_id=cast(str | None, row["current_checkpoint_id"]),
        created_at=_dt(row["created_at"]),
        updated_at=_dt(row["updated_at"]),
        archived_at=_dt(row["archived_at"]) if row["archived_at"] is not None else None,
    )


def _checkpoint(row: Mapping[str, Any]) -> CheckpointRecord:
    return CheckpointRecord(
        checkpoint_id=str(row["checkpoint_id"]),
        tenant_id=str(row["tenant_id"]),
        project_id=str(row["project_id"]),
        parent_id=cast(str | None, row["parent_id"]),
        manifest=cast(dict[str, str], row["manifest"]),
        db_snapshot_id=cast(str | None, row["db_snapshot_id"]),
        verified=bool(row["verified"]),
        label=cast(str | None, row["label"]),
        created_by_run_id=cast(str | None, row["created_by_run_id"]),
        created_at=_dt(row["created_at"]),
    )


def _lease(row: Mapping[str, Any]) -> LeaseRecord:
    return LeaseRecord(
        lease_id=str(row["lease_id"]),
        tenant_id=str(row["tenant_id"]),
        run_id=str(row["run_id"]),
        project_id=str(row["project_id"]),
        sandbox_id=str(row["sandbox_id"]),
        base_checkpoint_id=str(row["base_checkpoint_id"]),
        expires_at=_dt(row["expires_at"]),
        caps=cast(dict[str, int], row["caps"]),
        allowed_tools=tuple(cast(list[str], row["allowed_tools"])),
        status=cast(Any, row["status"]),
        released_at=_dt(row["released_at"]) if row["released_at"] is not None else None,
        created_at=_dt(row["created_at"]),
    )


def _quota(row: Mapping[str, Any]) -> QuotaEntry:
    return QuotaEntry(
        entry_id=str(row["entry_id"]),
        tenant_id=str(row["tenant_id"]),
        run_id=cast(str | None, row["run_id"]),
        amount=cast(Decimal, row["amount"]),
        kind=cast(Any, row["kind"]),
        source=str(row["source"]),
        description=str(row["description"]),
        created_at=_dt(row["created_at"]),
    )


def _audit(row: Mapping[str, Any]) -> AuditRecord:
    return AuditRecord(
        audit_id=int(row["audit_id"]),
        event_id=str(row["event_id"]),
        tenant_id=str(row["tenant_id"]),
        event_type=str(row["event_type"]),
        payload=cast(dict[str, Any], row["payload"]),
        prev_row_hash=cast(str | None, row["prev_row_hash"]),
        row_hash=str(row["row_hash"]),
        occurred_at=_dt(row["occurred_at"]),
    )


def _transactional(fn: Any) -> Any:
    """Commit on success, roll back on error.

    Without this, a mutating method's writes sit in the connection's implicit
    transaction: invisible to other connections (audit sink, quota guard) and
    discarded when the connection closes. psycopg's transaction() context
    manager gives exactly commit-on-success / rollback-on-error, nesting as
    savepoints when a caller already holds a transaction.
    """

    @functools.wraps(fn)
    def wrapper(self: _Store, *args: Any, **kwargs: Any) -> Any:
        with self._conn.transaction():
            return fn(self, *args, **kwargs)

    return wrapper


class _Store:
    def __init__(self, conn: Connection[dict[str, Any]]) -> None:
        self._conn = conn


class PostgresProjectStore(_Store):
    @_transactional
    def create(self, project: ProjectRecord) -> ProjectRecord:
        row = self._conn.execute(
            """
            INSERT INTO projects (
                project_id, tenant_id, owner_user_id, name, stack, current_checkpoint_id,
                created_at, updated_at, archived_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (
                project.project_id,
                project.tenant_id,
                project.owner_user_id,
                project.name,
                project.stack,
                project.current_checkpoint_id,
                project.created_at,
                project.updated_at,
                project.archived_at,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("project insert returned no row")
        return _project(row)

    def get(self, project_id: str, *, tenant_id: str) -> ProjectRecord | None:
        row = self._conn.execute(
            "SELECT * FROM projects WHERE project_id = %s AND tenant_id = %s",
            (project_id, tenant_id),
        ).fetchone()
        return _project(row) if row else None

    def list_for_tenant(self, tenant_id: str) -> tuple[ProjectRecord, ...]:
        rows = self._conn.execute(
            "SELECT * FROM projects WHERE tenant_id = %s ORDER BY created_at, project_id",
            (tenant_id,),
        ).fetchall()
        return tuple(_project(row) for row in rows)

    @_transactional
    def set_current_checkpoint(
        self, project_id: str, *, tenant_id: str, checkpoint_id: str
    ) -> ProjectRecord:
        row = self._conn.execute(
            """
            UPDATE projects
            SET current_checkpoint_id = %s, updated_at = now()
            WHERE project_id = %s AND tenant_id = %s
            RETURNING *
            """,
            (checkpoint_id, project_id, tenant_id),
        ).fetchone()
        if row is None:
            raise KeyError(project_id)
        return _project(row)

    @_transactional
    def rename(self, project_id: str, *, tenant_id: str, name: str) -> ProjectRecord:
        cleaned = name.strip()
        if not cleaned:
            raise ValueError("name must be non-empty")
        row = self._conn.execute(
            """
            UPDATE projects
            SET name = %s, updated_at = now()
            WHERE project_id = %s AND tenant_id = %s
            RETURNING *
            """,
            (cleaned, project_id, tenant_id),
        ).fetchone()
        if row is None:
            raise KeyError(project_id)
        return _project(row)

    @_transactional
    def archive(self, project_id: str, *, tenant_id: str) -> ProjectRecord:
        row = self._conn.execute(
            """
            UPDATE projects
            SET archived_at = now(), updated_at = now()
            WHERE project_id = %s AND tenant_id = %s
            RETURNING *
            """,
            (project_id, tenant_id),
        ).fetchone()
        if row is None:
            raise KeyError(project_id)
        return _project(row)

    @_transactional
    def restore(self, project_id: str, *, tenant_id: str) -> ProjectRecord:
        row = self._conn.execute(
            """
            UPDATE projects
            SET archived_at = NULL, updated_at = now()
            WHERE project_id = %s AND tenant_id = %s
            RETURNING *
            """,
            (project_id, tenant_id),
        ).fetchone()
        if row is None:
            raise KeyError(project_id)
        return _project(row)


class PostgresRunStore(_Store):
    @_transactional
    def create(self, run: RunRecord) -> RunRecord:
        row = self._conn.execute(
            """
            INSERT INTO runs (
                run_id, tenant_id, project_id, prompt, difficulty, status,
                budget_max_iterations, budget_max_tokens, budget_max_wall_clock_seconds,
                budget_max_credits, iterations, cost_credits, summary, created_at,
                started_at, finished_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (
                run.run_id,
                run.tenant_id,
                run.project_id,
                run.prompt,
                run.difficulty,
                run.status,
                run.budget.max_iterations,
                run.budget.max_tokens,
                run.budget.max_wall_clock_seconds,
                run.budget.max_credits,
                run.iterations,
                run.cost_credits,
                run.summary,
                run.created_at,
                run.started_at,
                run.finished_at,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("run insert returned no row")
        return _run(row)

    @_transactional
    def start(self, run_id: str, *, tenant_id: str) -> RunRecord:
        row = self._conn.execute(
            """
            UPDATE runs SET status = 'running', started_at = COALESCE(started_at, now())
            WHERE run_id = %s AND tenant_id = %s RETURNING *
            """,
            (run_id, tenant_id),
        ).fetchone()
        if row is None:
            raise KeyError(run_id)
        return _run(row)

    @_transactional
    def finish(
        self,
        run_id: str,
        *,
        tenant_id: str,
        status: RunStatus,
        summary: str = "",
        cost_credits: Decimal | None = None,
    ) -> RunRecord:
        if status not in {"succeeded", "failed", "cancelled"}:
            raise ValueError("finish status must be terminal")
        row = self._conn.execute(
            """
            UPDATE runs
            SET status = %s, summary = %s, cost_credits = COALESCE(%s, cost_credits),
                started_at = COALESCE(started_at, now()), finished_at = now()
            WHERE run_id = %s AND tenant_id = %s RETURNING *
            """,
            (status, summary, cost_credits, run_id, tenant_id),
        ).fetchone()
        if row is None:
            raise KeyError(run_id)
        return _run(row)

    @_transactional
    def update_progress(
        self, run_id: str, *, tenant_id: str, iterations: int, cost_credits: Decimal
    ) -> RunRecord:
        row = self._conn.execute(
            """
            UPDATE runs SET iterations = %s, cost_credits = %s
            WHERE run_id = %s AND tenant_id = %s RETURNING *
            """,
            (iterations, cost_credits, run_id, tenant_id),
        ).fetchone()
        if row is None:
            raise KeyError(run_id)
        return _run(row)

    def get(self, run_id: str, *, tenant_id: str) -> RunRecord | None:
        row = self._conn.execute(
            "SELECT * FROM runs WHERE run_id = %s AND tenant_id = %s",
            (run_id, tenant_id),
        ).fetchone()
        return _run(row) if row else None

    def list_for_project(self, project_id: str, *, tenant_id: str) -> tuple[RunRecord, ...]:
        rows = self._conn.execute(
            """
            SELECT * FROM runs
            WHERE project_id = %s AND tenant_id = %s
            ORDER BY created_at, run_id
            """,
            (project_id, tenant_id),
        ).fetchall()
        return tuple(_run(row) for row in rows)

    def list_for_tenant(self, tenant_id: str) -> tuple[RunRecord, ...]:
        rows = self._conn.execute(
            """
            SELECT * FROM runs
            WHERE tenant_id = %s
            ORDER BY created_at, run_id
            """,
            (tenant_id,),
        ).fetchall()
        return tuple(_run(row) for row in rows)

    @_transactional
    def append_event(self, event: RunEvent) -> RunEvent:
        self._conn.execute(
            """
            INSERT INTO run_events (event_id, run_id, event_type, detail, occurred_at)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                event.event_id,
                event.run_id,
                event.event_type,
                Jsonb(event.detail),
                event.occurred_at,
            ),
        )
        return event

    def events(self, run_id: str) -> tuple[RunEvent, ...]:
        rows = self._conn.execute(
            "SELECT * FROM run_events WHERE run_id = %s ORDER BY occurred_at, event_id",
            (run_id,),
        ).fetchall()
        return tuple(
            RunEvent(
                event_id=str(row["event_id"]),
                run_id=str(row["run_id"]),
                event_type=str(row["event_type"]),
                detail=cast(dict[str, Any], row["detail"]),
                occurred_at=_dt(row["occurred_at"]),
            )
            for row in rows
        )


class PostgresQuotaStore(_Store):
    @_transactional
    def append(self, entry: QuotaEntry) -> QuotaEntry:
        row = self._conn.execute(
            """
            INSERT INTO quota_ledger (
                entry_id, tenant_id, run_id, amount, kind, source, description, created_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (
                entry.entry_id,
                entry.tenant_id,
                entry.run_id,
                entry.amount,
                entry.kind,
                entry.source,
                entry.description,
                entry.created_at,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("quota insert returned no row")
        return _quota(row)

    def entries_for_tenant(self, tenant_id: str) -> tuple[QuotaEntry, ...]:
        rows = self._conn.execute(
            "SELECT * FROM quota_ledger WHERE tenant_id = %s ORDER BY created_at, entry_id",
            (tenant_id,),
        ).fetchall()
        return tuple(_quota(row) for row in rows)

    def balance(self, tenant_id: str) -> Decimal:
        total = Decimal("0")
        for entry in self.entries_for_tenant(tenant_id):
            total += entry.amount if entry.kind in {"credit", "release"} else -entry.amount
        return total


class PostgresAuditStore(_Store):
    @_transactional
    def append(self, event: AuditEvent | Mapping[str, Any]) -> AuditRecord:
        payload = event.to_dict() if isinstance(event, AuditEvent) else dict(event)
        occurred = payload.get("occurred_at")
        occurred_at = _dt(occurred) if occurred else now_utc()
        previous = self._conn.execute(
            "SELECT row_hash FROM audit_log ORDER BY audit_id DESC LIMIT 1"
        ).fetchone()
        prev_hash = str(previous["row_hash"]) if previous else None
        event_id = str(payload["event_id"])
        tenant_id = str(payload["tenant_id"])
        event_type = str(payload["type"])
        row_hash = audit_row_hash(
            event_id=event_id,
            tenant_id=tenant_id,
            event_type=event_type,
            payload=payload,
            occurred_at=occurred_at,
            prev_row_hash=prev_hash,
        )
        row = self._conn.execute(
            """
            INSERT INTO audit_log (
                event_id, tenant_id, event_type, payload, prev_row_hash, row_hash, occurred_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (event_id, tenant_id, event_type, Jsonb(payload), prev_hash, row_hash, occurred_at),
        ).fetchone()
        if row is None:
            raise RuntimeError("audit insert returned no row")
        return _audit(row)

    def list_for_tenant(self, tenant_id: str) -> tuple[AuditRecord, ...]:
        rows = self._conn.execute(
            "SELECT * FROM audit_log WHERE tenant_id = %s ORDER BY audit_id",
            (tenant_id,),
        ).fetchall()
        return tuple(_audit(row) for row in rows)

    def verify_chain(self, tenant_id: str | None = None) -> bool:
        if tenant_id is None:
            rows = self._conn.execute("SELECT * FROM audit_log ORDER BY audit_id").fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM audit_log WHERE tenant_id = %s ORDER BY audit_id",
                (tenant_id,),
            ).fetchall()
        previous: str | None = None
        for row in (_audit(r) for r in rows):
            expected = audit_row_hash(
                event_id=row.event_id,
                tenant_id=row.tenant_id,
                event_type=row.event_type,
                payload=row.payload,
                occurred_at=row.occurred_at,
                prev_row_hash=row.prev_row_hash,
            )
            if row.prev_row_hash != previous or row.row_hash != expected:
                return False
            previous = row.row_hash
        return True


class PostgresAppendOnlyAuditSink(_Store):
    """Audit sink for least-privilege writer roles with INSERT plus helper-function execute."""

    def emit(self, event: AuditEvent | Mapping[str, Any]) -> None:
        payload = event.to_dict() if isinstance(event, AuditEvent) else dict(event)
        occurred = payload.get("occurred_at")
        occurred_at = _dt(occurred) if occurred else now_utc()
        event_id = str(payload["event_id"])
        tenant_id = str(payload["tenant_id"])
        event_type = str(payload["type"])
        try:
            previous = self._conn.execute(
                "SELECT loopit_latest_audit_row_hash() AS row_hash"
            ).fetchone()
            prev_hash = str(previous["row_hash"]) if previous and previous["row_hash"] else None
            row_hash = audit_row_hash(
                event_id=event_id,
                tenant_id=tenant_id,
                event_type=event_type,
                payload=payload,
                occurred_at=occurred_at,
                prev_row_hash=prev_hash,
            )
            self._conn.execute(
                """
                INSERT INTO audit_log (
                    event_id, tenant_id, event_type, payload, prev_row_hash, row_hash, occurred_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (event_id, tenant_id, event_type, Jsonb(payload), prev_hash, row_hash, occurred_at),
            )
            self._conn.commit()
        except Exception:
            # A failed insert (for example an unknown tenant rejected by the
            # audit_log FK) aborts the transaction; without a rollback the
            # connection stays poisoned and every later emit fails too.
            self._conn.rollback()
            raise


class PostgresLeaseStore(_Store):
    def ensure_tenant(self, tenant_id: str) -> None:
        try:
            self._conn.execute(
                "INSERT INTO tenants (tenant_id, name) VALUES (%s, %s) "
                "ON CONFLICT (tenant_id) DO NOTHING",
                (tenant_id, tenant_id),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def create(self, lease: LeaseRecord) -> LeaseRecord:
        try:
            self._conn.execute(
                "INSERT INTO tenants (tenant_id, name) VALUES (%s, %s) "
                "ON CONFLICT (tenant_id) DO NOTHING",
                (lease.tenant_id, lease.tenant_id),
            )
            self._conn.execute(
                "INSERT INTO projects (project_id, tenant_id, name, stack) "
                "VALUES (%s, %s, %s, 'static') ON CONFLICT (project_id) DO NOTHING",
                (lease.project_id, lease.tenant_id, lease.project_id),
            )
            self._conn.execute(
                "INSERT INTO runs (run_id, tenant_id, project_id, prompt, status, "
                "budget_max_iterations) VALUES (%s, %s, %s, %s, 'running', 12) "
                "ON CONFLICT (run_id) DO NOTHING",
                (lease.run_id, lease.tenant_id, lease.project_id, "lease-tracked run"),
            )
            self._conn.execute(
                "INSERT INTO checkpoints (checkpoint_id, tenant_id, project_id, manifest, "
                "verified, label, created_by_run_id) VALUES (%s, %s, %s, '{}'::jsonb, true, "
                "'lease-base', %s) ON CONFLICT (checkpoint_id) DO NOTHING",
                (lease.base_checkpoint_id, lease.tenant_id, lease.project_id, lease.run_id),
            )
            row = self._conn.execute(
                """
                INSERT INTO sandbox_leases (
                    lease_id, tenant_id, run_id, project_id, sandbox_id, base_checkpoint_id,
                    expires_at, caps, allowed_tools, status, created_at, released_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    lease.lease_id,
                    lease.tenant_id,
                    lease.run_id,
                    lease.project_id,
                    lease.sandbox_id,
                    lease.base_checkpoint_id,
                    lease.expires_at,
                    Jsonb(lease.caps),
                    list(lease.allowed_tools),
                    lease.status,
                    lease.created_at,
                    lease.released_at,
                ),
            ).fetchone()
        except Exception:
            self._conn.rollback()
            raise
        if row is None:
            self._conn.rollback()
            raise RuntimeError("lease insert returned no row")
        record = _lease(row)
        self._conn.commit()
        return record

    def get(self, lease_id: str, *, tenant_id: str) -> LeaseRecord | None:
        try:
            row = self._conn.execute(
                "SELECT * FROM sandbox_leases WHERE lease_id = %s AND tenant_id = %s",
                (lease_id, tenant_id),
            ).fetchone()
        except Exception:
            self._conn.rollback()
            raise
        return _lease(row) if row else None

    def active_for_tenant(self, tenant_id: str) -> tuple[LeaseRecord, ...]:
        try:
            rows = self._conn.execute(
                """
                SELECT * FROM sandbox_leases
                WHERE tenant_id = %s AND status = 'active'
                ORDER BY created_at, lease_id
                """,
                (tenant_id,),
            ).fetchall()
        except Exception:
            self._conn.rollback()
            raise
        return tuple(_lease(row) for row in rows)

    def release(self, lease_id: str, *, tenant_id: str, reason: str = "completed") -> LeaseRecord:
        status = "expired" if reason == "expired" else "released"
        try:
            row = self._conn.execute(
                """
                UPDATE sandbox_leases SET status = %s, released_at = now()
                WHERE lease_id = %s AND tenant_id = %s RETURNING *
                """,
                (status, lease_id, tenant_id),
            ).fetchone()
        except Exception:
            self._conn.rollback()
            raise
        if row is None:
            self._conn.rollback()
            raise KeyError(lease_id)
        record = _lease(row)
        self._conn.commit()
        return record

    def renew(self, lease: LeaseRecord) -> LeaseRecord:
        try:
            row = self._conn.execute(
                """
                UPDATE sandbox_leases
                SET expires_at = %s, status = 'active', released_at = NULL
                WHERE lease_id = %s AND tenant_id = %s
                RETURNING *
                """,
                (lease.expires_at, lease.lease_id, lease.tenant_id),
            ).fetchone()
        except Exception:
            self._conn.rollback()
            raise
        if row is None:
            return self.create(lease)
        record = _lease(row)
        self._conn.commit()
        return record

    def expire_due(self) -> tuple[LeaseRecord, ...]:
        try:
            rows = self._conn.execute(
                """
                UPDATE sandbox_leases SET status = 'expired', released_at = now()
                WHERE status = 'active' AND expires_at <= now()
                RETURNING *
                """
            ).fetchall()
        except Exception:
            self._conn.rollback()
            raise
        expired = tuple(_lease(row) for row in rows)
        self._conn.commit()
        return expired


class PostgresCheckpointStore(_Store):
    @_transactional
    def create(self, checkpoint: CheckpointRecord) -> CheckpointRecord:
        row = self._conn.execute(
            """
            INSERT INTO checkpoints (
                checkpoint_id, tenant_id, project_id, parent_id, manifest, db_snapshot_id,
                verified, label, created_by_run_id, created_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (
                checkpoint.checkpoint_id,
                checkpoint.tenant_id,
                checkpoint.project_id,
                checkpoint.parent_id,
                Jsonb(checkpoint.manifest),
                checkpoint.db_snapshot_id,
                checkpoint.verified,
                checkpoint.label,
                checkpoint.created_by_run_id,
                checkpoint.created_at,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("checkpoint insert returned no row")
        self.set_current(
            checkpoint.project_id,
            tenant_id=checkpoint.tenant_id,
            checkpoint_id=checkpoint.checkpoint_id,
        )
        return _checkpoint(row)

    def get(self, checkpoint_id: str, *, tenant_id: str) -> CheckpointRecord | None:
        row = self._conn.execute(
            "SELECT * FROM checkpoints WHERE checkpoint_id = %s AND tenant_id = %s",
            (checkpoint_id, tenant_id),
        ).fetchone()
        return _checkpoint(row) if row else None

    def current(self, project_id: str, *, tenant_id: str) -> CheckpointRecord | None:
        row = self._conn.execute(
            """
            SELECT c.* FROM checkpoints c
            JOIN projects p ON p.current_checkpoint_id = c.checkpoint_id
            WHERE p.project_id = %s AND p.tenant_id = %s AND c.tenant_id = %s
            """,
            (project_id, tenant_id, tenant_id),
        ).fetchone()
        return _checkpoint(row) if row else None

    def ancestors(self, checkpoint_id: str, *, tenant_id: str) -> tuple[CheckpointRecord, ...]:
        found: list[CheckpointRecord] = []
        checkpoint = self.get(checkpoint_id, tenant_id=tenant_id)
        if checkpoint is None:
            raise KeyError(checkpoint_id)
        parent_id = checkpoint.parent_id
        while parent_id is not None:
            parent = self.get(parent_id, tenant_id=tenant_id)
            if parent is None:
                raise KeyError(parent_id)
            found.append(parent)
            parent_id = parent.parent_id
        return tuple(found)

    @_transactional
    def set_current(self, project_id: str, *, tenant_id: str, checkpoint_id: str) -> None:
        cursor = self._conn.execute(
            """
            UPDATE projects SET current_checkpoint_id = %s, updated_at = now()
            WHERE project_id = %s AND tenant_id = %s
            """,
            (checkpoint_id, project_id, tenant_id),
        )
        if cursor.rowcount == 0:
            raise KeyError(project_id)

    @_transactional
    def pin(self, checkpoint_id: str, *, run_id: str) -> None:
        self._conn.execute(
            """
            INSERT INTO checkpoint_pins (checkpoint_id, run_id)
            VALUES (%s, %s) ON CONFLICT DO NOTHING
            """,
            (checkpoint_id, run_id),
        )

    @_transactional
    def unpin(self, checkpoint_id: str, *, run_id: str) -> None:
        self._conn.execute(
            "DELETE FROM checkpoint_pins WHERE checkpoint_id = %s AND run_id = %s",
            (checkpoint_id, run_id),
        )

    def is_pinned(self, checkpoint_id: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM checkpoint_pins WHERE checkpoint_id = %s LIMIT 1",
            (checkpoint_id,),
        ).fetchone()
        return row is not None
