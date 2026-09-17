# Private files and account isolation: backend contract

This revision is local rebuild work, not a deployed change. Update clients before
deploying it. Anonymous /uploads URLs are intentionally retired; no compatibility
switch makes private files public again.

## Image upload

`POST /api/conversations/:conversationId/upload-image`

- Authenticate with the user JWT in `Authorization: Bearer ...`.
- Send multipart/form-data with one `image` field (maximum 10 MiB).
- PNG, JPEG, GIF and WebP signatures must match the declared MIME type.
- Use `new` to create a NEW conversation; otherwise ownership is checked before
  the multipart body is processed. Arbitrary unknown conversation IDs return 404.
- File operations require a database, including in development.

Response (201):

```json
{
  "success": true,
  "attachmentId": "uuid",
  "conversationId": "conversation-id",
  "id": "uuid",
  "name": "image.png",
  "mimeType": "image/png",
  "size": 1234,
  "url": "/api/files/uuid/content"
}
```

Use the returned conversationId and attachmentId for subsequent messages:

```json
{"content":"Describe this image","attachmentId":"uuid","mode":"chat"}
```

Streaming: `POST /api/conversations/:id/stream` (also `/api/agent/:id/stream`).
Legacy JSON response: `POST /api/conversations/:id/messages`, with
`tool: "vision-chat"` or `"analyze-image"`. Both resolve owned bytes rather than
forwarding filesystem paths. Legacy vision now uses the configured hosted chat
model endpoint; actual vision capability must still be benchmarked for that model.

`imagePath` input is rejected even if valid text is also supplied. A file must
belong to both the caller and the specified conversation. To reuse a file in
another conversation, upload it to that conversation; silent cross-project reuse
is not implemented.

## Download and deletion

- `GET /api/files/:id`: owner-visible metadata/reference.
- `GET /api/files/:id/content`: authenticated bytes.
- `DELETE /api/files/:id`: revoke and delete; repeated owner calls return 204.
- JWTs and developer API keys are supported for these file endpoints.
- Missing credentials return 401. Missing, foreign or deleted files return 404.
- No query-string credentials or public signed-link feature exists yet.

Browser clients must fetch bytes using their authorization header, then manage a
local object URL for supported image/media rendering. Revoke object URLs when no
longer needed. Ordinary anonymous img/video/download links are not compatible.
Do not render HTML/SVG or executable artifacts in the application origin; the
separate isolated preview service is still a later milestone.

Responses carry private/no-store caching, nosniff, a sandbox CSP, and attachment
disposition. Full-file reads are bounded at 50 MiB; ranged video streaming and
large-object streaming are not implemented by this local adapter.

## Generated content

Built-in document/image/video tools, media workers, image generation APIs and
`POST /v1/media/publish` save owner-scoped file records. URL responses use
`/api/files/:id/content`. Media-publish responses include `access: "private"`.
An API key may download its owner's existing files without a positive inference
balance; reads do not start a billable generation.

Old files are not automatically assigned to users based on filenames. Requests
to /uploads return 410 and do not disclose whether a file exists. Existing
LibreChat/media consumers expecting anonymous URLs require an authenticated
download adapter before cutover. The new owned frontend will consume this
contract. No claim of legacy client compatibility is made.

## Storage and lifecycle

- Development-only default byte root: `backend/data/private-files` from backend/.
- Override with server-controlled PRIVATE_FILES_DIR; never accept it from a client.
- Stored filenames are generated UUIDs. Display names are sanitized separately.
- Metadata stores owner, optional conversation, MIME, size, SHA-256 and deletion.
- Reads check ownership before touching disk, reject symlinks and verify integrity.
- A failed metadata insertion attempts byte cleanup. Explicit file deletion marks
  access revoked before unlinking and permits retrying cleanup.
- Account/conversation deletion cascades metadata and therefore revokes access,
  but may leave orphan bytes. Garbage collection is a pending workstream.
- Production requires durable storage; this adapter alone is not appropriate for
  independently scaled replicas. Object storage, quotas, content inspection and
  retention enforcement remain release requirements.

### Production namespace contract (03o)

Require `PRIVATE_FILES_STORAGE_MODE=shared-filesystem`, an absolute
`PRIVATE_FILES_DIR`, and a stable lowercase UUID `PRIVATE_FILES_STORE_ID`. Explicit
storage mode also enables strict validation outside production. The marker
`.loop-private-store.json` must contain exactly `{ "version": 1, "id": "<UUID>" }`.
Run `node scripts/private-storage.mjs --init` only against an existing empty root
or its already-matching marker, then `--check`. Normal startup does not initialize
or adopt storage. An unidentified nonempty root is refused, never overwritten.

Canary write/read/fsync/cleanup and free-space checks reject unavailable storage;
`PRIVATE_FILES_MIN_FREE_BYTES` defaults to 67,108,864 bytes. This is advisory
headroom, not a quota reservation or proof of shared physical durability.

Linux leaf operations stay anchored to an operation-bound directory descriptor
through `/proc/self/fd`; root identity/marker are rechecked before publication.
Missing procfs fails closed. Windows requires trusted stable ancestors and
quiesced mount changes: Node cannot make privileged swap-and-restore atomic there.
Filesystem checks and database commits are not one atomic transaction; detected
replacement/crashes may leave inaccessible orphan bytes rather than unsafe cleanup.

Already-staged video settlement can proceed when a write probe fails but the
namespace remains readable and valid. Invalid identity blocks even that recovery.
See `../deploy/owned-staging/README.md` for single-PVC release and rollback steps.

## Administration and development

Registration never grants admin based on account count or ADMIN_EMAIL. Existing
roles are not modified. An operator can explicitly promote an existing account:

```sh
npm run make-admin -- --help
npm run make-admin -- account@example.com admin
```

DATABASE_URL must be set explicitly for a role change. No role changes were made
against production as part of this implementation.

Local guest authentication requires BOTH NODE_ENV=development and
ENABLE_DEV_MODE=true. It is not a customer feature, does not bypass ownership,
and does not grant administrator access. Its seeded password is random.
