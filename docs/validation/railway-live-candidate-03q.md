# Live isolated Railway candidate — 03q

Date: 2026-09-18. **The owned candidate is deployed and verified, not cut over to
the old production domains.** Application source: release branch
`release/owned-staging-20260917`, commit
`d0c8765a5d7b326d5a029e550edd9e2f9d225ebd` (code change `b9dd2cb`).

Live HTTPS origin: **https://web-production-20d369.up.railway.app**

## Isolated resources

Workspace `red-kits's Projects`: `26b57846-b7ec-4c53-b40b-cfa3fe8cfa3b`, PRO.
Project `loop-gpt-owned-staging-20260917`: `8584f5ac-2000-4311-9dae-ae283b70216f`.
Environment: `2faec73c-12aa-47c9-9a6c-94a9276eb6d5`.
Railway named this new project's default environment **production**; that label
does not refer to, replace, or migrate the existing `loop-gpt` production project.

| Resource | ID / setting |
| --- | --- |
| PostgreSQL service | `1444acfe-be89-45bb-890c-e4ed1026d5a8` |
| API + three-worker service | `4bc8d358-95fa-4836-bbcf-724e6d8d7f57` |
| Owned web service | `cd5c8ac2-adc4-407c-a5e4-38353a888bd6` |
| PostgreSQL volume | `7fa1e712-9b72-49e2-83d6-65caca22df2b`, `/var/lib/postgresql/data` |
| Private-file volume | `f1c0dee1-561a-46d9-890c-52104818c24b`, `/private-store` |
| Web domain | `efc2baf4-1566-4e73-938f-3c559316428b`, target port8080 |

Each service runs one replica in `sfo`; volumes were created at the platform's
50,000 MB capacity setting. No public database TCP proxy or public backend domain
was created. Web reaches API over Railway private networking on port3001.
Backend readiness uses port3002, `/ready`; deployment overlap0 and draining35s.

## Provisioning and platform findings

- Used authenticated remote Railway MCP for project/services/volumes/domains,
  variable configuration, source connections and deployment inspection. The public
  API supplied overlap/draining settings missing from the MCP update tool.
- Generated fresh database/JWT/encryption secrets in memory and set them directly
  in Railway. Values were never printed, saved in source, passed as build args, or
  copied from production. The initializer refuses to overwrite populated services.
  The namespace UUID is retained in Railway with its volume.
- New PostgreSQL image: `postgres:16.10-bookworm`; backend DATABASE_URL uses
  Railway references to that service's password/private domain, database
  `loop_staging`. Old PostgreSQL/MongoDB and their contents were not touched.
- Railway rejected setting `railwayConfigFile` because legacy Config as Code is
  deprecated. Explicit service settings were used instead. The old JSON files are
  reference configuration, not proof that Railway consumed them. A checked-in
  current Infrastructure-as-Code definition remains follow-up work.
- Initial attached-volume maintenance used the candidate image with
  `RAILWAY_RUN_UID=0`, no deployment healthcheck and restart NEVER. It ran the
  reviewed empty-directory preparer, dropped supplementary groups/GID/UID to1000,
  ran `private-storage.mjs --init` then `--check`, and applied all ten migrations.
  Terminal evidence: `CANDIDATE_MAINTENANCE_COMPLETE uid=1000`.
- Restored runtime UID1000, supervisor command, `/ready`, ON_FAILURE/max3 and no
  predeploy initialization/migration. Normal startup remains check-only.
- Two MCP `redeploy` attempts selected Railpack even though inspected service
  configuration said DOCKERFILE. They failed during build before starting the
  app. Reconnecting the same reviewed source triggered a fresh Docker build and
  succeeded; the volume was not reset and maintenance was not rerun.

## Deployment evidence

| Deployment | ID | Result |
| --- | --- | --- |
| PostgreSQL | `47006bc7-5f6b-4e55-9141-099081c18903` | SUCCESS |
| Web | `be2992f0-3873-411a-99e7-f2b0ef8b4da8` | SUCCESS |
| One-off maintenance | `cd91baab-aaf2-4bd1-ba45-196fe55f2a66` | completed successfully; superseded |
| First runtime redeploy | `8d58581f-24fc-43df-953d-685d56419e5f` | FAILED, wrong builder |
| Second runtime redeploy | `1efb0086-533c-4067-9bab-88aa65303540` | FAILED, wrong builder |
| Fresh runtime deployment | `30dbc422-4ebf-4960-8640-4690248bce24` | SUCCESS |

Maintenance build digest:
`sha256:f856889dbca7f13e996686a7927313a6f9bbf3e324223648b29918117e156529`.
Do not assume a later rebuilt image has the identical digest merely because the
Git revision is unchanged; dependency/OS repositories are not snapshot pinned.

## Live acceptance

Twenty HTTPS application requests passed against the new origin:

- HTML, healthz, service worker and manifest:200; CSP and SW cache headers checked.
- Unauthenticated account access:401.
- Two canary registrations/logins:200; both roles are `user`, including first signup.
- Personal workspace creation/list:200; another user's connections lookup:404.
- Invalid usage limit:400, followed by a successful account request:200.
- PNG upload:201; anonymous download:401; cross-user download:404; owner download:200.
- Download bytes matched upload SHA256; attachment disposition/no-store verified.
- Owned test file deleted:204; test conversation deleted:200.

The first anonymous harness attempt used a nonexistent `/api/account/credits`
path. It was corrected to the existing `/api/account/me` route; no app code was
changed to accommodate the harness.

Real Chromium over HTTPS then passed login and logout, rendered the workspace
screen at1440x1000 and390x844, reported zero page errors and no horizontal mobile
overflow. Desktop/phone screenshots were read and visually checked. This browser
pass did not submit a model request or test physical iOS/Android devices.

An SSH runtime check reported:

```json
{"appPid1Uid":"1000","sshUid":0,"markerMatches":true,"readiness":{"ready":true},"videoEnabled":"false","paymentsEnabled":"false"}
```

Railway SSH exec starts as root independently of the app's UID. The application
PID1 is1000. Cleanup explicitly dropped to UID1000, selected only the three exact
new canary user IDs, checked their user role and `railway-check-...@example.invalid`
addresses, and removed them. Their owned test workspace/tokens cascaded. Result:

```json
{"executionUid":1000,"canaryUsersRemoved":3,"canaryUsersRemaining":0,"migrationsApplied":10}
```

No customer account was selected or deleted. Test files/conversations were already
removed through authenticated endpoints. The two volumes are retained normally.

Temporary operator tools/evidence (outside the repository):
`C:/Users/chris/AppData/Local/Temp/opencode/railway-mcp-session.mjs`,
`loop-live-acceptance.mjs`, `loop-live-browser.mjs`,
`loop-live-desktop.png`, `loop-live-phone.png` and scoped request JSON files.
Quoted Node SSH expressions were rejected by shell parsing on the first check;
subsequent checks used an encoded script through stdin, without persistent remote
script files or credential output.

## Not a production cutover

- Existing production domains/services/databases stay in the old project. No
  account/project transfer, DNS switch, old-service deletion or backup reset ran.
- This is a fresh database. Existing customer/owner logins have not been migrated;
  temporary acceptance accounts were removed. Owner onboarding/access is next.
- No hosted provider credentials were provisioned; no paid model request or
  streaming generation was performed. Configure reviewed hosted providers securely
  before claiming working chat/generation. Email delivery/OAuth integrations also
  require their own staging configuration.
- Payments and accounted video stay disabled. Other missing product/native
  capabilities in `../PRODUCTION_CHECKLIST.md` remain unfinished.
- Production PostgreSQL18 compatibility, migration baselining, database/volume
  backups and restore rehearsal, runtime shutdown qualification, monitoring and
  old-to-new user/history/file mapping are not proven by these staging checks.
- Historical credentials still require coordinated rotation. The new environment
  does not reuse them. Do not switch production domains until these prerequisites
  are resolved and the intended application flows are qualified.
