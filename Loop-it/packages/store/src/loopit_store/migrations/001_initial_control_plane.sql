CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
    tenant_id text PRIMARY KEY,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orgs (
    org_id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    user_id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
    email text NOT NULL,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE TABLE projects (
    project_id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
    owner_user_id text REFERENCES users (user_id),
    name text NOT NULL,
    stack text NOT NULL,
    current_checkpoint_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);

CREATE TABLE runs (
    run_id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
    project_id text NOT NULL REFERENCES projects (project_id),
    prompt text NOT NULL,
    difficulty text NOT NULL DEFAULT 'implementation',
    status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    budget_max_iterations integer NOT NULL CHECK (budget_max_iterations > 0),
    budget_max_tokens integer CHECK (budget_max_tokens IS NULL OR budget_max_tokens > 0),
    budget_max_wall_clock_seconds integer CHECK (
        budget_max_wall_clock_seconds IS NULL OR budget_max_wall_clock_seconds > 0
    ),
    budget_max_credits numeric(20, 8) CHECK (budget_max_credits IS NULL OR budget_max_credits >= 0),
    iterations integer NOT NULL DEFAULT 0 CHECK (iterations >= 0),
    cost_credits numeric(20, 8) NOT NULL DEFAULT 0 CHECK (cost_credits >= 0),
    summary text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    CHECK (finished_at IS NULL OR started_at IS NOT NULL)
);

CREATE TABLE run_events (
    event_id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES runs (run_id),
    event_type text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checkpoints (
    checkpoint_id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
    project_id text NOT NULL REFERENCES projects (project_id),
    parent_id text REFERENCES checkpoints (checkpoint_id),
    manifest jsonb NOT NULL,
    db_snapshot_id text,
    verified boolean NOT NULL DEFAULT false,
    label text,
    created_by_run_id text REFERENCES runs (run_id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checkpoint_pins (
    checkpoint_id text NOT NULL REFERENCES checkpoints (checkpoint_id),
    run_id text NOT NULL REFERENCES runs (run_id),
    pinned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (checkpoint_id, run_id)
);

ALTER TABLE projects
    ADD CONSTRAINT projects_current_checkpoint_fk
    FOREIGN KEY (current_checkpoint_id) REFERENCES checkpoints (checkpoint_id);

CREATE TABLE sandbox_leases (
    lease_id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
    run_id text NOT NULL REFERENCES runs (run_id),
    project_id text NOT NULL REFERENCES projects (project_id),
    sandbox_id text NOT NULL,
    base_checkpoint_id text NOT NULL REFERENCES checkpoints (checkpoint_id),
    expires_at timestamptz NOT NULL,
    caps jsonb NOT NULL,
    allowed_tools text[] NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz
);

CREATE TABLE quota_ledger (
    entry_id text NOT NULL,
    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
    run_id text REFERENCES runs (run_id),
    amount numeric(20, 8) NOT NULL,
    kind text NOT NULL CHECK (kind IN ('credit', 'debit', 'reservation', 'release', 'settlement')),
    source text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, entry_id)
);

CREATE TABLE audit_log (
    audit_id bigserial NOT NULL,
    event_id text NOT NULL,
    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    prev_row_hash text,
    row_hash text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (audit_id, occurred_at),
    UNIQUE (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

CREATE OR REPLACE FUNCTION audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only; corrections must be new audit records';
END;
$$;

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
REVOKE UPDATE, DELETE ON audit_log_default FROM PUBLIC;

CREATE TABLE secrets (
    secret_id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES tenants (tenant_id),
    project_id text REFERENCES projects (project_id),
    name text NOT NULL,
    encrypted_blob bytea NOT NULL,
    encryption_key_ref text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    rotated_at timestamptz,
    revoked_at timestamptz,
    UNIQUE (tenant_id, project_id, name)
);

CREATE INDEX runs_tenant_project_idx ON runs (tenant_id, project_id, created_at DESC);
CREATE INDEX run_events_run_idx ON run_events (run_id, occurred_at);
CREATE INDEX checkpoints_project_idx ON checkpoints (tenant_id, project_id, created_at DESC);
CREATE INDEX checkpoint_pins_run_idx ON checkpoint_pins (run_id);
CREATE INDEX sandbox_leases_active_idx ON sandbox_leases (tenant_id, status, expires_at);
CREATE INDEX quota_ledger_tenant_idx ON quota_ledger (tenant_id, created_at);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, occurred_at);
