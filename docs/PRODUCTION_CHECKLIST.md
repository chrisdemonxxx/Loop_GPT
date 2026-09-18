# Remaining production build — current scope, not a completion claim

Updated through live isolated candidate 03q. See the release evidence for publication status. Existing
gateway/LibreChat deployment is separate from the owned product being built.
Most remaining items are implementation work, not merely external approvals.

## Already implemented and locally verified

- Backend release/migration foundation, authentication and owner-bound private files.
- Workspace membership/run authorization and encrypted connection configuration.
- Opt-in read-only Notion and GitLab search adapters; other catalog entries are not implemented adapters.
- Reviewed public web, model, provider and media HTTP boundaries.
- Atomic daily and prepaid reservations; synchronous paid routes enforce them.
- Durable **daily settlement** evidence and recovery worker with distributed claims.
- Durable **prepaid confirmed-usage capture** evidence/recovery, preserving exactly-once settlement.
  Neither worker is a general task engine or a provider reconciliation/resubmission service.
- Daily and prepaid reservation-linked video worker implemented, both default-off
  pending live provider and deployment/storage qualification.
- Shared video queue admission/dispatch limits and persistent upstream occupancy.
- Production private-storage identity guards and read-only staged settlement recovery.
- Fail-closed signed payment ingress; checkout and fulfillment are code-locked off.
- Single-replica owned-staging packaging and isolated local Docker acceptance.
- Owned React/TypeScript web/PWA: login, workspace selection, hosted streaming,
  authenticated downloads, seven UI locales, and read-only API usage.
- Local automated tests/builds, backend container builds and smoke checks.

## 1. Billing and commercial readiness — release-blocking

- [x] Durable evidence/recovery for prepaid captures with confirmed usage.
- [ ] Reconciliation of missing/partial provider usage and uncertain submissions.
- [ ] Provider reconciliation for unknown work without persisted settlement evidence.
- [ ] Customer-facing reservation/hold history, accurate available balance, and refund/support tools.
- [x] Signed fail-closed payment ingress; unsigned and unsafe legacy grants removed.
- [ ] Durable event inbox, exact payment bindings, deduplication/ordering, transactional fulfillment and refund/subscription reconciliation; checkout remains locked off.
- [x] Prepaid job-linked reservation, fenced video dispatch and settlement (default-off).
- [x] Daily/JWT video-job accounting with exclusive ledger binding and immutable debit evidence.
- [x] Shared video queue caps and explicit production filesystem identity/preflight guards.
- [ ] Live provider, deployed storage, capacity and recovery qualification before enabling either video pool.
- [ ] Exact or explicitly estimated aggregate usage across agent/research turns and media fallbacks.
- [ ] Pricing/cost/capacity benchmarks and approval of the actual merchant offering.
- [ ] Operational alerts/replay procedure for conflicting/dead-letter settlements.

Daily recovery only handles immutable evidence that reached the DB. Crashes before
that write cannot be reconstructed automatically. No blanket age-based refunds.

## 2. Durable execution and managed environments

- [ ] General persisted runs, steps/events, reconnect/resume API, cancellation and crash recovery.
- [x] Fenced prepaid-video dispatch and retained-hold handling for ambiguous submission.
- [ ] General provider/task dispatch, HTTP creation idempotency and reconciliation tooling.
- [x] Video-only shared global/per-user admission and active limits with fair bounded claims.
- [ ] General task concurrency/scheduling, aggregate spend limits and capacity qualification.
- [ ] Isolated code/browser sandbox provisioning, filesystem/network/process limits and teardown.
- [ ] Repository checkout, execution, tests, diffs, patch review, previews and project retrieval.
- [ ] Durable background tasks and scheduling integrated with authorization and billing.

Both video pools are off by default; automatic legacy-job resumption remains disabled.
The video worker does not constitute a general hosted task engine.

## 3. Identity, workspaces and storage

- [ ] Invitations/organizations, membership lifecycle, owner transfer and workspace deletion.
- [ ] Consistent current workspace authorization/revocation for legacy messages/media/files.
- [ ] Session refresh/revocation/logout, OAuth/email acceptance, account lifecycle and retention/deletion.
- [ ] Managed credential rotation/KMS and revocation of historically exposed credentials.
- [ ] Rotate/revoke the historical tunnel credential and legacy spike backend API key without disrupting existing consumers.
- [x] Stop tracking/baking the legacy tunnel credential; local file preserved.
- [x] Private filesystem marker, bounded I/O and Linux operation-bound namespace checks.
- [ ] Object storage suitable for multiple replicas, quotas, retention and orphan cleanup.
- [ ] Isolated previews/content inspection and complete authenticated attachment UX.
- [ ] Backup/restore and migration/cutover of existing private/legacy file references.

## 4. Owned web/PWA product

- [ ] Workspace-filtered conversation history/search and complete file/project management.
- [ ] Canvas and artifact editing, repository-aware coding workflow and isolated previews.
- [ ] Project/document ingestion, retrieval, citations and knowledge management.
- [ ] Full API console: key lifecycle, pricing, usage/holds, billing and developer onboarding.
- [ ] Connection setup/OAuth, agents/skills/task management and administrative operations.
- [ ] End-to-end localization across newly built features, email, billing and native clients.
- [ ] Real-backend acceptance, accessibility audit, Safari/iPhone and offline/update lifecycle tests.

Seven current UI locale choices are en-US, en-GB, en-CA, fr-CA, en-AU, en-NZ,
en-IE. Chromium phone-width tests are not Safari or physical-device qualification.

## 5. Integrations, agents and evaluated private learning

- [ ] Full planned connector catalog with least-privilege OAuth/token lifecycle and bounded pagination.
- [ ] Approved write operations, previews/confirmation and idempotent retry contracts.
- [ ] Packaged, isolated, workspace-scoped MCP integrations; never reactivate global registries.
- [ ] Reusable agents and bounded multi-agent delegation with scoped authority and budgets.
- [ ] Private versioned memories/skills with evaluation, activation, revision and rollback.
- [ ] Automatic learning workflow backed by evaluations; not unreviewed shared prompt mutation or weight training.

## 6. Store/Direct editions and native delivery

- [ ] Expo Android/iOS clients; existing Capacitor website wrapper is not the requested rebuild.
- [ ] Server-enforced edition policy, entitlements, data segregation and age/region controls.
- [ ] Store-appropriate product surfaces and broader Direct Edition, without reviewer-specific behavior.
- [ ] Android AAB/store and direct APK signing/builds; native iOS engineering and device verification.
- [ ] Permitted Direct iOS distribution, separately from engineering completion.
- [ ] Optimized Direct iPhone PWA where native Direct distribution is unavailable.
- [ ] Native accessibility/localization, notifications/background behavior, upgrades and recovery.
- [ ] Physical-device testing, signing/provisioning and store/distribution review.

Target markets remain US, UK, Canada, Australia, New Zealand and Ireland. No
store approval, native signing credentials or distribution eligibility is assumed.

## 7. Production qualification and rollout

- [ ] Live model/tool/vision/media/connector compatibility and least-privilege credential tests.
- [ ] Dependency/container/code security assessment, abuse controls and penetration testing.
- [ ] Infrastructure egress firewall, secret management, isolated previews/sandboxes and data policy.
- [ ] Multi-replica, failure-injection, load, capacity, latency and cost qualification.
- [ ] Monitoring, alerts, audit retention, incident response and support operations.
- [x] Local isolated owned-staging package, smoke harness and CI workflow definition.
- [x] Reviewed release branch and remote CI; isolated Railway deployment, attached-volume initialization and initial TLS/auth/file/browser acceptance.
- [x] Working hosted models: dedicated endpoints wired with discovered model names; standard/large chat, embeddings and fail-closed fences verified live with metered ledger evidence (03r).
- [x] Owner account provisioned (`owner@loop-gpt.cyou`, admin) with verified `requireAdmin` gates; real invitations and email/OAuth integration still pending.
- [x] Product chat verified live end-to-end: SSE stream, message persistence and daily ledger; browser UI send/render with zero page errors (03s).
- [x] `backend/scripts/promote-admin.mjs` operator CLI added and verified (idempotent; exit 2 for usage, 3 for missing user).
- [ ] Provision image (and, with accounted flags, video) endpoints; retire the shared-router embeddings dependence; reconcile the `-vl` naming with text-only checkpoints.
- [ ] Replace deprecated Railway config-as-code release instructions with current IaC and qualify runtime shutdown/rollback.
- [ ] Migration baselining, backups, restore rehearsal and deployed rollback qualification.
- [ ] End-to-end browser/native/product acceptance against staging with real integrations.
- [ ] Explicit reviewed release/cutover preserving existing environments.

## Dependency order

Next: release review/secret remediation, remote CI and isolated staging qualification;
missing/partial-evidence reconciliation and complete transactional payment
fulfillment; workspace/session/storage lifecycle. Then durable task/sandbox execution
and the full product interfaces, integrations and native editions. Client modules
can proceed in parallel where backend contracts are stable. Live qualification
and external approvals are separate from implementation and must not be marked
complete from local tests alone.

Evidence and exact scope: `BUILD_PROGRESS.md`, `ACCOUNTING.md`,
`DAILY_SETTLEMENT_RECOVERY.md`, `API_SETTLEMENT_RECOVERY.md`,
`ACCOUNTED_VIDEO_JOBS.md`, `validation/foundation-03o.md`, `validation/release-candidate-03p.md`, `../web/VALIDATION.md`,
`../deploy/owned-staging/README.md`.

Live candidate evidence: `validation/railway-live-candidate-03q.md`.
