# Data Handling Policy Draft

This draft requires legal and security review before it is published to customers. It is not legal
advice, but it is the source of truth for the launch privacy/data-handling summary.

## Data flows

User prompts, generated code, run logs, audit records, project secrets, checkpoints, verification output,
previews, deployment metadata, account/org records, and billing records flow through Loop-it. Agent-generated
code executes only in leased data-plane sandboxes.

## Retention

Operators must define production retention periods for prompts, audit logs, checkpoints, sandbox artifacts,
telemetry, billing records, and backups before launch. Audit records are append-only; corrections are new
events.

## Deletion

Document identity deletion, project export, checkpoint/object purge, secret revocation, backup expiry, and
subprocessor deletion requests. Secrets must be revoked before deleting their backing records.

## Export and ownership

Users own generated code. Git sync and export are the supported no-lock-in paths and should include source,
migrations, seed data, and metadata needed to rebuild outside Loop-it.

## Training use

Do not train or fine-tune on user prompts, code, traces, or verification output by default. Any future
training use requires explicit consent and a clear opt-out path.
