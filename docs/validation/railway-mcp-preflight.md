# Railway MCP deployment preflight

Date: 2026-09-17. Requested operation: deploy the owned candidate and replace the
existing infrastructure, preserving data and a rollback path.

## Connection and release

Confirmed the installed, authenticated **remote Railway MCP**, through
`railway mcp proxy` over stdio using the project's installed MCP SDK. This is an
actual MCP check, not an inference from CLI login. No new token was required, read
from configuration, printed, or persisted. Temporary client/request files are in
the approved local `AppData/Local/Temp/opencode` directory, outside the repository.

Branch: `release/owned-staging-20260917`; code `b9dd2cb`, documentary HEAD `d0c8765`.
All four code workflows previously passed; the documentary HEAD's secret-scan run
also passed: https://github.com/chrisdemonxxx/Loop_GPT/actions/runs/35264420869.

## Actual MCP operations and results

1. `list-workspaces`: access to `chrisdemonxxx's Projects` confirmed.
2. `describe-environment`: production `loop-gpt` has seven existing services:
   frontend, backend, librechat, librechat-rag, cf-tunnel, Postgres and MongoDB.
   Latest deployment status is SUCCESS for each; this is metadata, not an
   end-to-end HTTP or application health test.
3. `create-project`: attempted a private, separate project named
   `loop-gpt-owned-staging-20260917` in the same workspace. This avoids modifying
   existing production while candidate validation and migration are incomplete.
   Returned `isError: true` with:

   > Your trial has expired. Please select a plan to continue using Railway.

4. `list-projects`: still five projects; the requested candidate project is absent.
5. `get-staged-changes`: production has no staged changes, no destructive patch.
6. `list-domains`: existing frontend owns `loop-gpt.cyou` and `app.loop-gpt.cyou`;
   backend owns `api.loop-gpt.cyou`; LibreChat owns `chat.loop-gpt.cyou`. No domain
   was added, moved, removed, or reconfigured.

## Storage and cutover observations

- Existing database volumes: `postgres-volume` at `/var/lib/postgresql/data` and
  `mongodb-volume` at `/data/db`, each 5,000 MB in asia-southeast1-eqsg3a.
- Existing PostgreSQL uses Railway's PostgreSQL 18 image; local candidate database
  tests used PostgreSQL 16. Neither version compatibility nor production migration
  baselining/restore has been qualified for the existing database.
- Current frontend/backend source metadata references `Seentiourcio47/loop-gpt`;
  the reviewed release is on `chrisdemonxxx/Loop_GPT`. A future deployment must
  explicitly select the reviewed source instead of assuming current autodeploys
  follow the candidate.
- No values were fetched through `list-variables`. No production database query,
  backup, migration, container restart or infrastructure cutover was performed.
- No new project, service, database, volume, secret or domain was created. Existing
  infrastructure remains unchanged. Payments/live video in the candidate remain off.

## Blocking action and resume

**Authentication works; workspace billing still prevents project creation.**
An operator must activate a Railway plan for this workspace, or explicitly select
another suitable funded workspace. Do not request another token as a substitute
for resolving the billing error. No billing purchase was attempted.

After billing is resolved, recheck candidate-project absence and create it once.
Provision isolated data/secrets, deploy the reviewed release, perform live
acceptance and qualify backups/restores/migrations. Only then switch intended
domains/traffic, retaining old services and database snapshots for rollback.
Do not try an unqualified in-place production overwrite to work around the block.

## Recheck after new workspace became visible

On the subsequent requested deployment recheck, the authenticated MCP identity
remained `chrisdemonxxx@gmail.com`. `list-workspaces` additionally returned
`red-kits's Projects` (26b57846-b7ec-4c53-b40b-cfa3fe8cfa3b), with zero projects.
The original workspace still returned the expired-trial error on creation.

An explicit `create-project` attempt targeting the new workspace returned
`isError: true`:

> You need member access to this workspace to create a project.

Visibility is therefore not sufficient provisioning permission. No creation
succeeded, and no existing project was transferred, modified, or redeployed.
The new workspace's plan status has not been independently established by a
successful provisioning operation.

Next: the new workspace owner grants Member/Admin workspace access to the MCP
identity and that invitation is accepted, or the MCP is reauthorized as its owner.
Recheck workspace access and absence of the candidate before retrying once. Do not
post account tokens in chat or attempt to self-promote through another interface.
