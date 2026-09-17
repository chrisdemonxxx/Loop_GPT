# Loop GPT build ledger

## Confirmed scope

- Owned React/TypeScript web application and iPhone-optimized PWA.
- Expo native Store and Direct editions; separate server-side policy boundaries.
- Native Direct iOS engineering completion is distinct from permitted distribution.
- US, UK, Canada, Australia, New Zealand, Ireland; en-US, en-GB, en-CA,
  fr-CA, en-AU, en-NZ, en-IE across the customer experience.
- Individuals/developers, hosted Loop models, metered API credits.
- Managed code/browser sandboxes, durable background tasks, coding workflow,
  Canvas, project retrieval, packaged MCP integrations, full planned connector
  catalog, reusable agents, and evaluated automatic private skill learning.
- Full scope retained; solo founder with AI assistance; no customer migration
  requirement reported. This is not permission to erase existing environments.
- Payment/infrastructure acceptance and regional distribution are external
  release gates. No processor eligibility, store approval, or native signing is
  assumed. No payment/provider accounts have been modified by this build.

## Milestones

| Milestone | Status |
| --- | --- |
| M0: architecture, baseline, commercial feasibility | Local baseline established; external eligibility/cost/model benchmarks pending |
| M1: safe releases, auth, tenancy, vault, ledger, audit | In progress: through 03o verified locally; storage identity and locked fail-closed payment ingress added; fulfillment, reconciliation, live qualification and workspace lifecycle pending |
| M2: durable execution and managed sandbox | Settlement and daily/prepaid video workers plus shared video queue limits implemented; general tasks, spend budgets and managed sandboxes pending |
| M3: repo-aware coding, tests, diffs, previews | Not started |
| M4: owned UI/PWA, Canvas, API console, localization | Owned web/PWA login, workspaces, streaming, downloads, seven locales and read-only API usage implemented/tested; Canvas, retrieval and full console pending |
| M5: connectors, multi-agent orchestration, skills/learning | Two opt-in read-only adapters implemented locally; broader catalog, orchestration and learning pending |
| M6: native builds and device qualification | Not started |
| M7: production qualification and rollout | Isolated owned-staging packaging passes local smoke; remote CI, deployment and production qualification pending |

## Foundation batch 1

Implemented:
- Removed implicit destructive schema synchronization from container startup.
- Added a version-controlled baseline migration matching the existing schema.
- Switched container installs to npm ci; moved images to Node 22/bookworm.
- Production environment validation runs before service initialization. It rejects
  insecure frontend origins and development authentication bypass. Database URLs
  and credentials must be present and must not use placeholder defaults.
- Unexpected process-level failures exit instead of keeping a damaged worker alive.
- CORS accepts only explicitly configured origins; removed shared-hosting wildcard trust.
- Chat history fetches the latest bounded window and restores chronological order.
- One-time tokens are hashed at rest and claimed using a conditional atomic write.
- Voucher capacity, redemption, and grants share a serializable transaction, with
  bounded retries for serialization conflicts.
- Unit tests cannot inherit DATABASE_URL; integration tests require an explicitly
  named localhost-only test database.
- Added CI validation using disposable PostgreSQL, migration checks, tests, and a
  production image build. CI itself has not run remotely (no push performed).

Verification record is in `docs/validation/foundation-01.md`.

## Foundation batch 2: account/file isolation

Implemented:
- JWT middleware validates bearer syntax, algorithm and a usable user identity.
  Development access requires explicit opt-in and never grants administration.
- Public registration always creates a regular user; administrator provisioning
  is a separate CLI, now packaged in the production image without tsx.
- Conversation/message reads and writes retain ownership predicates in development.
  Missing caller-selected conversation IDs no longer create records implicitly.
- Added a PrivateFile metadata table and an owner-scoped local storage service.
  Uploads and generated artifacts return authenticated file references.
- Input images use attachmentId, never a client-provided filesystem path. The
  streaming and legacy vision paths resolve authorized bytes before model use.
- File downloads support owner JWTs/developer keys, no-store headers, nosniff,
  sandbox CSP and attachment disposition. Deletion revokes metadata access first.
- Removed the public /uploads mount; that legacy path now returns 410.
- Upgraded Multer to 2.4.0 and its types to 2.2.0. Uploads are bounded and checked
  against allowed image signatures; this is not full decoding or antivirus scanning.
- Added Windows/Linux HTTP + PostgreSQL tests, including Linux symlink rejection.

See `docs/PRIVATE_FILES.md` for the intentional client contract changes, and
`docs/validation/foundation-02.md` for verification evidence.

## Foundation checkpoint 03a: workspace configuration and vault

Implemented:
- Additive Workspace, WorkspaceMember, WorkspaceConnection and WorkspaceAuditEvent
  models, database-enforced role enum, nullable conversation workspace relation.
- Authenticated workspace creation/listing, idempotent personal provisioning,
  member read/downgrade/removal, owner-only connection writes and audit reads.
- Encrypted connection configuration using AES-256-GCM and workspace/record-bound
  associated data, with no default key or plaintext fallback.
- Metadata-only responses, bounded request parsing, full credential replacement
  with mandatory version checks, transactional audit and serialization conflicts.
- Internal credential loader rechecks current membership and connection version,
  availability and ownership; tests reject revoked/downgraded access and tampering.
- Real HTTP/PostgreSQL regressions and Windows/Linux validation.

See `docs/WORKSPACES.md` and `docs/validation/foundation-03a.md` for contracts and
evidence. This is a verified substep, **not completion of foundation batch 3**.
At 03a the agent runtime did not consume workspace records; global routes and
dispatch were unchanged. Those boundaries were superseded by 03b below. The
connector catalog reported `executionEnabled: false` at 03a; 03d supersedes this
for two adapters. No connector-provider requests were made during validation.

## Foundation checkpoint 03b: built-in runtime authorization

Implemented and tested:
- Workspace identity and owner/editor checks on both streaming aliases; lazy
  binding of old conversations only to their owner's personal workspace.
- Server-private per-run grants capturing reviewed handlers. Copied/forged grants,
  identity changes, unselected tools and global-registration replacement fail closed.
- Fresh access checks before model turns and tool dispatch; native and inline
  calls share the gate. Chat stays tool-free even when skill triggers match.
- AJV argument validation, including invalid/falsy input and extra fields.
- Research authorization outside network-failure fallbacks; permission removal
  blocks subsequent search/fetch/verification/synthesis calls.
- Removed global extension management handlers (410), stopped shared-extension
  bootstrap, removed creator tools and global user-skill prompt injection.
- Process-wide provider settings now require an administrator, even in development.
- Credit-check exceptions stop streaming setup with 503. Durable ledger work is
  still pending; this does not close all billing gaps.

Evidence: `docs/validation/foundation-03b.md`. Contracts and limitations:
`docs/RUNTIME_AUTHORIZATION.md`. At 03b stored workspace connectors remained disabled.

## Foundation checkpoint 03c: public web egress

Implemented:
- Direct HTTP(S) transport with public-address checks, DNS pinning, isolated
  agents, exact-origin policy support and conservative redirect handling.
- Shared request deadlines, cancellation, header/body caps and independent
  wire/decompressed response limits; generic errors do not reflect provider bodies.
- Migrated web_fetch and all web_search providers; research passes cancellation.
- Closed DOMs after extraction, bounded search results and reviewed connector
  rollout candidates without enabling the unsafe legacy factory.

Contracts/readiness: `docs/PUBLIC_HTTP.md`. Evidence:
`docs/validation/foundation-03c.md`. New network tests use mocked DNS/transports;
no live website/provider integration is claimed. At 03c stored connectors remained disabled.

## Foundation checkpoint 03d: opt-in workspace search connectors

Implemented and verified locally:
- Notion title search and GitLab.com member-project search; fixed HTTPS endpoints,
  header credentials, no redirects, bounded arguments/responses and first-page
  projected metadata only. No writes, arbitrary endpoints or legacy factory reuse.
- Metadata-only tool discovery requiring owner/editor; explicit `connectionIds`
  selection on both streaming aliases, with `toolNames` able to narrow further.
- Captured identity/type/version and live credential checks at dispatch, after
  DNS before socket creation, and before returning results. Generic failures and
  exact token-echo redaction keep tested secret values out of results/events/history.
- 210 unit tests plus 91 Linux HTTP/PostgreSQL integration tests passed; Windows
  integration: 90 passed and one existing symlink test skipped. Production image
  builds and network-disabled non-root smoke passed. No schema change; migration
  repeat and schema diff passed on a disposable database.

Evidence and touched files: `docs/validation/foundation-03d.md`. API contracts:
`docs/WORKSPACES.md` and `docs/RUNTIME_AUTHORIZATION.md`. Provider requests are
mocked in validation; no live Notion/GitLab certification, deployment or commit.

## Foundation checkpoint 03e: hosted model request boundary

Implemented and verified locally:
- Shared hosted-only selection on both agent streaming and CLI-completion aliases.
  Client provider/key/URL/multi-model overrides are rejected before side effects
  or SDK construction. Public model aliases resolve only to operator targets.
- CLI completion envelope validation, generic startup/midstream errors and upstream
  cancellation on disconnect. Successful response/SSE framing is retained.
- 15 new unit tests and 13 new HTTP/runtime integration tests. Full Linux result:
  225 unit + 104 integration tests passed. Windows integration: 103 passed, one
  existing symlink skip. Production build/non-root smoke and migration repeat/diff
  passed. No deployment, schema change or live provider request.

Evidence: `docs/validation/foundation-03e.md`. API contract and compatibility:
`docs/RUNTIME_AUTHORIZATION.md`. This only closes client override paths on these
routes; legacy messages/multi-model state, SDK egress and media remain blockers.

## Foundation checkpoint 03f: legacy messages and shared model state

Implemented and verified locally:
- Legacy messages validate raw hosted selection before stripping unknown fields,
  then use request-local hosted chat/vision calls and owned history/attachments.
- Removed that route's shared multi-model/interaction-mode dispatcher and global
  OpenAI client. No alternate-provider fallback or raw provider-error reflection.
- Retired global `/api/models/selection` for every authenticated verb/subpath;
  removed implicit development bypass. The public model catalog remains available.
- Explicit 400 responses for unsupported legacy planning/agentic/automation,
  schedules and placeholder MCP/creation tools. Planned replacements remain pending.
- Added 19 integration regressions, including concurrent caller isolation and
  cancellation. Final Linux suite: 225 unit + 123 integration tests passed;
  Windows integration: 122 passed, one existing symlink skip. Production image
  route smoke, fresh/repeat migrations and schema diff passed.

Evidence: `docs/validation/foundation-03f.md`. Breaking API changes:
`docs/RUNTIME_AUTHORIZATION.md`. Model/image providers are mocked in tests; no live
provider certification or deployment. Image transport, legacy workspace lifecycle,
no-database fallbacks and metering remain release gates.

## Foundation checkpoint 03g: SDK destination/credential containment

Implemented and verified locally:
- Operator/fixed-root validation, explicit credentials and removal of ambient
  OpenAI destination/tenant-header inheritance in the model client factory.
- Captured exact chat-completion endpoint/authorization guard, JSON/header checks,
  dedicated validating HTTPS agents, no redirects and generic transport failures.
- Real installed SDK URL/header construction, JSON and SSE/tool-call parsing tested
  with a mocked fetch boundary. No live provider calls or TLS certification.
- v1 SDK construction failures now return generic 502 rather than escaping the
  Express async handler; raw upstream errors are not logged/returned by that catch.
- 40 new unit tests and two v1 regressions. Linux: 265 unit + 125 integration tests;
  Windows integration: 124 passed, one existing symlink skip. Production image
  build/non-root rejection smoke and schema/migration checks passed.

Policy/limits: `docs/MODEL_HTTP.md`. Evidence: `docs/validation/foundation-03g.md`.
This is not DNS-pinned/full-budget model egress; separate clients/media remain.

## Foundation checkpoint 03h: pinned and bounded model responses

Implemented and verified locally:
- Shared all-answer public DNS validation and per-request pinned HTTPS agent lookup,
  preserving original Host/SNI and prohibiting use of late/cancelled DNS results.
- 32 MiB request, 8 MiB identity-only response, 16 KiB normalized header budgets;
  one deadline through DNS/headers/body consumption (default 5 minutes, max 10).
- Backpressured response counting, EOF checks, source/error/cancellation cleanup,
  disposal of late fetch responses and timeout of unconsumed/stalled bodies.
- v1 streaming/nonstreaming disconnects now cancel upstream model calls. Partial
  usage settlement remains unimplemented; this is not a billing-reservation fix.
- Direct pinned node-fetch dependency and types replace the private SDK shim import.
  Clean Docker dependency installs and Prisma generation succeeded.
- 31 additional unit tests and two disconnect integration tests. Linux: 296 unit
  + 127 integration tests passed. Windows integration: 126 passed, one symlink skip.
  Production build, bounded-body/deadline smoke and migration repeat/diff passed.

Policy and compatibility: `docs/MODEL_HTTP.md`. Evidence:
`docs/validation/foundation-03h.md`. DNS/fetch delegates are mocked in tests;
real SDK parsing/streams are exercised, but live provider/TLS qualification is not.

## Foundation checkpoint 03i: independent providers and media

Implemented and verified locally:
- Bounded buffered provider transport: public HTTPS, exact credential origins,
  pinned DNS, identity-only responses, no redirects, shared deadline/cancellation.
- Separately reviewed fixed-path operator sidecar policy; private HTTP is allowed
  only through that entry point, without credential headers.
- Migrated embeddings, image/video generation/downloads, persisted video workers,
  independent chat clients and administrator model discovery. Removed discovery's
  credential-insensitive cache and query/base-URL override behavior.
- Persisted origin and budget anchors, current status checks and conditional writes
  prevent a late worker overwriting job cancellation/completion. This is not a lease.
- Fail-closed agent media credit-check errors, legacy image disconnect propagation,
  and research planning/verification cancellation without fallback.
- Windows/Linux: 611 unit tests; Linux: 142 integration tests; Windows: 141 with
  one existing symlink skip. Production image and real loopback transport smoke
  passed under network-none/UID 1000. Repeat migrations/schema diff passed.
- Added a reusable smoke script and CI step; remote CI has not run. No live provider
  request, production migration, deployment, commit or push was performed.

Policy: `docs/PROVIDER_MEDIA_HTTP.md`. Evidence:
`docs/validation/foundation-03i.md`. The entire rebuild remains incomplete.

## Next implementation slice

Complete global/user queue limits, storage safeguards and provider qualification
before enabling video delivery. Daily/prepaid claims/publication are implemented
through 03n behind off-by-default flags. Missing/partial-usage reconciliation remains pending.
The synchronous entry points reserve daily
or prepaid balances; uncertain holds still require reconciliation. Harden payment
webhook authentication/event handling before any public paid launch. Extend workspace
lifecycle/revocation to legacy message/media/file paths. Complete organization
invitations and private skills rather than importing shared plaintext credentials.
Metering must fail closed and use reservations before
new paid execution paths are enabled. Do not enable live checkout before the
merchant offering is accepted.

## Known remaining production blockers

- Committed provider/API credential replacement and external revocation.
- Remaining reviewed workspace connector/MCP adapters and private skills (global extension
  routes and bootstrap are retired, not migrated).
- Live model/media provider compatibility, deployment egress rules and full legacy
  workspace lifecycle; application transport controls are not a network firewall.
- Incomplete auth/session protections.
- Private-file object-storage adapter, quotas, orphan cleanup, isolated previews,
  authenticated client download integration, and legacy-link migration.
- Signed fail-closed webhooks/event idempotency, durable reservation recovery,
  customer hold visibility, exact aggregate usage and job-linked settlement.
- In-process/request-bound execution, distributed job leases/concurrency and sandbox isolation.
- Legacy incompatible execution/media paths and permissive database fallbacks.
- Full dependency vulnerability audit and remaining targeted upgrades. Multer 1.x
  has been replaced; other deprecations remain. A successful build is not a security audit.
- Model/tool compatibility, paid-provider integration, frontend/mobile verification.

This ledger records completed evidence separately from planned work. It does not
declare the application production-ready or claim work continues when no process
is running.

## Foundation checkpoint 03j and owned client foundation

- Added atomic prepaid and daily reservation/dispatch/capture contracts, one-time
  preview grants and reference-based top-up deduplication. Missing DB/users no
  longer authorize free daily execution. No Stripe integration change is implied.
- Integrated reviewed synchronous v1 and JWT agent/CLI/legacy/media-tool paths.
  Retained uncertain holds rather than silently refunding possibly consumed work.
- Corrected setup disconnect handling, cancellation during reservation, settlement
  ordering and duplicate artifact charges. Disabled both async-video creation paths
  and startup legacy-job resumption until durable accounting is implemented.
- Backend: Windows/Linux 638 unit tests; Linux 284 integration tests; Windows 283
  plus the existing symlink skip. Five additive migrations, repeat/schema diff,
  production images and network-disabled transport smoke verified locally.
- New `web/`: owned React/TypeScript client with memory-only auth, explicit workspace
  selection, cancellable hosted streaming, authenticated downloads, seven locales,
  read-only API overview and offline app-shell-only PWA. Existing gateway untouched.
  Build, 94 unit/component tests and four fixture Chromium browser tests passed.
- Added web CI definition; remote CI, live provider usage, native/iPhone Safari and
  real backend-to-browser acceptance have not been qualified.

Contracts: `docs/ACCOUNTING.md`, `web/README.md`. Evidence:
`docs/validation/foundation-03j.md`, `web/VALIDATION.md`.

## Foundation checkpoint 03k: daily settlement recovery

- Immutable validated evidence before capture; queued work never becomes a
  successful foreground response until capture commits.
- Distributed SKIP LOCKED claims, database-clock leases, fencing, bounded worker
  concurrency/retries and terminal conflict/dead-letter handling. Claims are made
  only for available slots rather than expiring in a local pre-leased queue.
- Packaged separate-process CLI with --once, bounded polling and graceful POSIX
  shutdown. Interrupted one-shot batches return non-success.
- Windows/Linux 675 unit tests; Linux 308 integration tests; Windows 307 plus the
  existing symlink skip. Six migrations, repeat/schema diff and worker image
  startup checks passed. No live providers, deployment or background daemon left.

This does not recover missing evidence, implement prepaid/provider reconciliation,
or re-enable async video. Full remaining scope: `docs/PRODUCTION_CHECKLIST.md`.
Contract/evidence: `docs/DAILY_SETTLEMENT_RECOVERY.md`, `docs/validation/foundation-03k.md`.

## Foundation checkpoint 03l: prepaid confirmed-usage recovery

- Committed immutable evidence before prepaid capture; foreground still requires
  successful settlement. Known intent recovery can complete after a failed capture.
- Distributed DB-clock claims, fencing, available-slot waves, bounded retries and
  conflict/dead-letter handling. Duplicate/reclaimed workers do not duplicate money
  or usage. Manual settlement conflicts and exact historical captures are preserved.
- Packaged separate worker CLI; unknown work without evidence is never automatically
  refunded or resubmitted. Async video remains disabled.
- Main validation: 720 unit tests on Windows/Linux; 343 Linux integration tests;
  340 Windows integration tests plus symlink/two POSIX-signal skips. Seven migrations,
  repeat/schema diff and seeded production-image capture/replay smoke passed.
- No deployment, live payment/model request, commit/push or remote CI run.

Contract/evidence: `docs/API_SETTLEMENT_RECOVERY.md`, `docs/validation/foundation-03l.md`.

## Foundation checkpoint 03m: prepaid video jobs

- Atomic prepaid reservation/job creation, cross-process leased/fenced worker,
  at-most-once POST attempt, bounded GET recovery and retained ambiguous holds.
- Staged immutable private bytes plus confirmed settlement evidence; final capture
  and accessible output publication are transactional. Cancellation is rechecked
  under publication locks, including legacy status-only cancellation writers.
- Default-off flag/configuration pauses network jobs without consuming attempts;
  committed settlement can still finish. JWT/daily jobs remain 503.
- Narrow bounded MP4/AVC admission replaces signature-only billable success.
  Real fixture video bytes, audio-only/header/truncation and lifecycle races tested.
- Windows/Linux 767 unit tests; Linux 388 integration tests; Windows 385 plus three
  platform-specific skips. Eight migrations, schema comparison, production worker
  startup/one-shot and idle SIGTERM exit verified. Provider networking remains mocked.

Contract/evidence: `docs/ACCOUNTED_VIDEO_JOBS.md`, `docs/validation/foundation-03m.md`.

## Foundation checkpoint 03n: daily/JWT accounted video

- Atomic daily reservation/job creation and exclusive daily-or-prepaid ledger links.
  Daily owner/model/request/config and original credit window are server-bound.
- Shared fenced dispatch/publication supports both settlement workers. Queued refunds
  cannot increase a new window; post-submit uncertainty retains its deduction.
- Separate daily flag pauses daily network work while prepaid remains eligible;
  known completion may settle with both flags off. Developer keys cannot access
  daily-job routes, while artifact access remains account-wide as documented.
- Audit hardening makes original daily debit amounts/owner/window immutable;
  rejected internal edits cannot inflate refunds. No historical corruption is repaired.
- 767 unit tests on Windows/Linux; 420 Linux integration tests; Windows 417 with
  three platform-specific skips. Nine migrations, schema comparison and production
  worker packaging/idle checks passed. No live provider or deployment activity.

Evidence: `docs/validation/foundation-03n.md`; updated job contract in
`docs/ACCOUNTED_VIDEO_JOBS.md`.

## Foundation checkpoint 03o: shared limits, storage and staging validation

- Shared PostgreSQL video queue policy applies across users, keys, billing pools
  and workers. Atomic admission precedes debit; durable upstream slots retain
  ambiguous work, while confirmed settlement frees capacity. No automatic resubmit.
- Production private storage requires explicit mode, absolute canonical root and
  stable UUID marker. Linux operation-bound directory descriptors prevent pathname
  replacement from retargeting leaf I/O. Read-only/low-space storage permits only
  already-staged settlement; invalid namespace identity blocks all work.
- Removed unsigned Stripe fallback and unsafe metadata-driven fulfillment. Signed
  ingress fails closed; checkout/fulfillment remain code-locked unavailable until
  durable inbox, exact bindings and transactional/reversal handling are implemented.
- Owned web/API/three-worker single-replica staging packaging passes isolated Docker
  smoke. Added fixture-only CI workflow; no remote workflow or deployment ran.
- Independent main validation: Windows 936 units + 5 skips and 455 integrations +
  3 skips; Linux 941 units and 458 integrations, no skips. Ten migrations, repeat
  deployment and schema comparison passed. Web: 94 tests and 4 Chromium fixtures.
- Tunnel credential untracked but preserved locally; image no longer copies it.
  Historical credential exposure still requires coordinated rotation/revocation.
  Legacy Render startup no longer performs destructive schema synchronization.
- Everything remains uncommitted; existing production and unrelated local services
  were not changed. No live provider/payment requests or native-device qualification.

Evidence: `docs/validation/foundation-03o.md`,
`deploy/owned-staging/VALIDATION.md`, `web/VALIDATION.md`.

## Release review 03p

- Fixed request-local async rejection containment and strict usage-limit validation;
  public OAuth signup no longer has first-user or ADMIN_EMAIL promotion paths.
- Fixed probe overlap, multiline nginx configuration, nested Docker exclusions,
  cleanup exit status and explicit attached-volume maintenance overrides.
- Main Linux build: 996 units and 458 integrations passed; packaging regressions
  and rebuilt fixture smoke passed. Detailed boundaries and commands are recorded.
- Reviewed staged diff and full candidate tree with redacted local Gitleaks. Removed
  a legacy spike literal API key; historical key/tunnel exposure still needs rotation.
- Added complete candidate-tree secret-scan CI. No production cutover is authorized
  by successful local tests; remote CI and new staging require separate evidence.

Evidence: `docs/validation/release-candidate-03p.md`.
