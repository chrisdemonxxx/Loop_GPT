# Workspace configuration and connectors (through foundation 03d)

This API implements workspace membership checks and encrypted connection
management. Checkpoint 03d enables explicitly selected Notion title search and
GitLab.com project search through workspace-bound streaming execution. Other
connectors remain configuration-only. See `docs/RUNTIME_AUTHORIZATION.md` for
run selection and remaining gates. Provider compatibility has not been live-tested.

## Authentication and roles

All endpoints are under `/api/workspaces` and require the account bearer JWT.
Platform administrator status grants no implicit workspace access. The explicit
development identity still needs a real account/membership; no workspace bypass
was added. Responses use `Cache-Control: no-store`.

| Role | Allowed operations in this checkpoint |
| --- | --- |
| viewer | List workspace memberships, member IDs, connector metadata/catalog |
| editor | Viewer access plus reviewed-tool discovery and scoped execution |
| owner | Editor access plus connection writes, member downgrade/removal, audit reads |

New workspaces contain only their owner. There is deliberately no endpoint that
silently adds another account. Invitations/acceptance, owner transfer, account
deletion lifecycle, and organization-level membership are subsequent work.
Owners cannot be removed/demoted using these member endpoints.

## Endpoints

| Method/path | Behavior |
| --- | --- |
| `GET /` | List caller's workspace memberships |
| `POST /personal` with `{}` | Idempotently provision/retrieve caller's personal workspace |
| `POST /` with `{"name":"Project team"}` | Create a workspace owned by the caller |
| `GET /:workspaceId/members` | List member IDs/roles, without account emails |
| `PATCH /:workspaceId/members/:userId` | Existing member role `editor` or `viewer` |
| `DELETE /:workspaceId/members/:userId` | Remove an existing non-owner member |
| `GET /:workspaceId/connections/catalog` | Configuration support and field metadata |
| `GET /:workspaceId/connections` | Connection metadata only; no config/ciphertext |
| `GET /:workspaceId/connections/:connectionId/tools` | Owner/editor: reviewed tool definitions, no credentials; disabled/missing returns 404, unsupported adapter 422 |
| `POST /:workspaceId/connections` | Create an encrypted connection |
| `PUT /:workspaceId/connections/:id` | Full replacement with `expectedVersion` |
| `DELETE /:workspaceId/connections/:id` | Delete connection and audit the action |
| `GET /:workspaceId/audit` | Owner-only metadata audit records |

List endpoints return up to 100 rows and a `nextCursor`. Pass it as `?after=...`
for the next page. Cursors sort lexically by resource ID (by workspace/user ID
for memberships), not by creation time. Lists are not snapshot-isolated across
requests. API JSON bodies are limited to 64 KiB, and credential strings to 8,000
characters. Invalid or oversized JSON returns a generic 400/413 within the
workspace router instead of reaching the general body-logging error handler.

Create body example (use a real key only through your authenticated client):

```json
{
  "type": "notion",
  "name": "My notes",
  "enabled": true,
  "config": { "token": "<provider-token>" }
}
```

For replacement, send the full body plus `"expectedVersion": 1` (or the current
metadata version). Omission of a version is an error, not an unconditional write.
Success increments the version; concurrent/stale writes return 409. Credentials
are never merged with hidden values. Disabling also requires full replacement.
Deletion returns 204; repeating it returns 404 with no further change.

`configurationSupported` identifies fixed-HTTPS-origin catalog entries that can
be stored now. OAuth-only and configurable-origin adapters are rejected. Only
Notion and GitLab catalog entries return `executionEnabled: true`; this means a
reviewed adapter exists, not that a stored token works or an individual connection
is enabled. Saving credentials does not validate them with a provider.

## Encryption and operations

- Set server-side `CONNECTION_ENCRYPTION_KEY` to canonical base64 encoding of
  exactly 32 cryptographically random bytes, provided by a secret manager. Never
  put it in client configuration, source control, logs, or the database.
- AES-256-GCM uses a new 12-byte IV per write. Associated data binds the envelope
  to its workspace and connection ID. Altered/transplanted ciphertext fails
  authentication. The versioned JSON envelope stores IV, authentication tag and
  ciphertext only.
- Missing/malformed keys cause write/decryption operations to return 503; there
  is no plaintext fallback or default production key. Metadata reads still work.
- Back up the key separately from database backups. Simply changing it makes old
  envelopes unreadable. Automated master-key rotation, key rings/KMS integration,
  and re-encryption tooling are **not implemented** in this checkpoint.
- Names and configured-field names are readable metadata: do not put secrets in
  names. Management queries do not select ciphertext. Audit events contain actor,
  action, workspace and resource IDs, not credential values.
- Connection writes and their audit entries share a serializable transaction.
  Serialization conflicts return 409 without partial commits.

## Runtime integration status

`loadConnectionForExecution(userId, workspaceId, id, version)` verifies current
membership, requires owner/editor, and queries enabled/version/workspace ownership
before decrypting. The database query also checks membership again. Its tests
cover downgrade/removal, disable/delete, rotation and ciphertext substitution.

Reviewed connection handlers invoke this loader at dispatch, again after DNS
before the HTTP socket is opened, and after the provider response before returning
results. Definitions capture connection identity/type/version, not tokens. Rotation,
disable/delete and role downgrade/removal invalidate captured access; a new run
is required after credential rotation. Results are withheld if a recheck fails.
Checks do not create an atomic transaction with a remote provider: revocation
cannot retract an already-issued request or data already returned to a caller.

Discovery returns one `readOnly: true` tool named
`connection_<connection UUID without hyphens>_search`. Both adapters accept only
`query` (1-500 characters, nonblank) and optional `limit` (integer 1-20, default 10).
Notion searches titles of shared pages/databases, not their full content. GitLab
searches project metadata with `membership=true`; self-hosted GitLab is unsupported.
Each call returns first-page projected metadata only, with `hasMore` and `page: 1`.
There is no cursor/pagination continuation or write operation in this checkpoint.

Requests use fixed HTTPS origins, no redirects, a 15-second HTTP deadline and
512 KiB wire/decoded response caps. Serialized summaries are capped at 16 KiB.
Credentials go in headers, never tool schemas; selected text/link fields redact
exact token and percent-encoded token echoes. This is not a general-purpose DLP
filter. Provider exceptions produce a generic error, not raw payloads. Use a
dedicated least-privilege integration token and restrict its provider-side access.
The Notion adapter sends API version `2022-06-28`; validate provider compatibility
before rollout. HTTP construction and isolation tests mock provider transport.

The nullable `Conversation.workspaceId` column is now used by streaming runs.
Unbound conversations are assigned to their owner's personal workspace on first
streaming use, never automatically shared or moved. Legacy endpoints still use
user ownership. No legacy plaintext configuration was imported and no production
database was migrated. Public onboarding must remain blocked until
the remaining M1/runtime boundaries and other release gates are satisfied.
