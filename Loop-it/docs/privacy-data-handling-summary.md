# Privacy and data-handling summary

This summary is operational documentation, not legal advice. Legal review must approve the customer-facing
policy before launch.

## What Loop-it processes

Loop-it processes account details, organization membership, prompts, generated code, checkpoints, run logs,
audit events, billing records, project secrets, verification output, previews, and deployment metadata.

## How data is protected

Generated code executes only in data-plane sandboxes. Sandboxes receive no ambient credentials, route model
calls through the router, and use default-deny egress. Secrets are scoped and short-lived where supported.

## Retention and deletion

Operators must define production retention windows for prompts, checkpoints, logs, audit records, telemetry,
backups, and billing records. Audit corrections are appended as new events. Deletion should revoke secrets,
expire backups according to policy, and preserve records that must be retained for security or legal reasons.

## Export and no lock-in

Users own generated code. Git sync and full export should include source, migrations, seed data, and metadata
needed to rebuild outside Loop-it.

## Training use

Do not train or fine-tune on user traces by default. Any future training use requires explicit consent and a
clear opt-out path.
