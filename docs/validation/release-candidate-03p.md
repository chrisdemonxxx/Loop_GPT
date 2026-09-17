# Release-candidate review 03p

Date: 2026-09-17. Based on foundation03o; this record covers release review fixes,
not production qualification. Remote CI passed; Railway creation is blocked by
an expired trial as recorded below. Payments and video remain default-off.

## Publication and remote CI

Release branch: `release/owned-staging-20260917`.
Code commit: `b9dd2cb35aaa338ba9525ee396c42d0a3e6453ae`
(`feat!: prepare isolated owned staging candidate`). Pushed to the existing origin;
no PR, merge, production cutover or history rewrite was performed.

All four workflows completed successfully for that exact commit:

| Workflow | Successful run |
| --- | --- |
| Backend validation | https://github.com/chrisdemonxxx/Loop_GPT/actions/runs/35263937079 |
| Owned web validation | https://github.com/chrisdemonxxx/Loop_GPT/actions/runs/35263936999 |
| Owned staging validation | https://github.com/chrisdemonxxx/Loop_GPT/actions/runs/35263937029 |
| Release secret scan | https://github.com/chrisdemonxxx/Loop_GPT/actions/runs/35263936997 |

## Railway attempt and resume point

Authenticated project/workspace metadata was inspected without fetching variables.
Railway's `ServiceCreateInput.environmentId` documentation states that service
creation can propagate across non-fork environments in a project. To avoid any
change to the existing production project, creation was attempted for a separate
private project `loop-gpt-owned-staging-20260917`, default environment `staging`,
in the same workspace, with PR deployments disabled and no source duplication.

`projectCreate` returned no data and this error:

> Your trial has expired. Please select a plan to continue using Railway.

A subsequent `railway list --json` confirmed that no project with the requested
name exists. No new staging database, volume, service, secret or domain was
provisioned. Existing production resources were not mutated. No billing plan was
selected or purchased. **An active Railway plan is required to resume.**

After the operator resolves billing, recheck access and project absence; create
the isolated project once, then use only its returned project/environment/service
IDs for new DB/PVC/secrets. Deploy the reviewed candidate with explicit migration
and attached-volume maintenance, then verify real HTTPS/readiness/auth/file and
shutdown behavior. Do not fall back to an existing production service or duplicate
production secrets just to bypass this block.

## Review fixes

- A malformed account usage limit could reject outside Express 4 and reach fatal
  process-error handling. Limits now accept only decimal integers 1..200; expected
  request failures stay within explicit async wrappers, including API-key middleware
  and the reviewed account/admin/developer/media/agent/v1/OAuth/email handlers.
  Sanitized errors preserve v1 envelopes and safely terminate partial responses.
- OAuth public signup always creates role `user`, regardless of first-user status
  or ADMIN_EMAIL. Operator provisioning remains separate. Other OAuth/session
  lifecycle milestones are not claimed complete.
- Timed-out readiness probes retain their in-flight guard until underlying I/O
  settles; late success does not restore readiness or permit overlapping probes.
- Web runtime rejects CR/LF across whole configuration values before substitution.
- Docker ignore files apply sensitive-filename exclusions after recursive allowlists.
- Smoke cleanup failures fail the run; success follows verified cleanup.
- Attached-PVC maintenance instructions explicitly replace command/user/healthcheck/
  restart overrides before restoring the non-root supervisor configuration.

## Validation after fixes

- Main Linux validation image: TypeScript build and **996 unit tests, 38 files**.
- Main Linux fresh database: all ten migrations and **458 integrations, 18 files**.
- Backend implementation agent: Windows build and **991 units + five platform skips**;
  new local HTTP regressions account for 55 cases. Provider/DB effects are mocked
  there; the full integration suite separately uses PostgreSQL/HTTP/filesystem.
- Packaging agent: 11 focused regressions on Windows and non-root Linux Node22;
  rebuilt smoke passed all six groups, nine multiline rejection cases, and three
  actual Docker-context tests with 57 exclusions / 16 retention assertions.
- Owned web's 94 component/unit and four Chromium tests passed at03o; these were
  not repeated by main at03p. Only its container configuration changed in this slice.

Validation image `loop-gpt-backend:validation-03p`:
`sha256:9a3ee281a0c9ac86f53c071f222bc0651c2045206bd7e691a40b580c44e46038`.
Cached dependency layers are not a fresh dependency audit. External providers and
payments were never contacted. See `../../deploy/owned-staging/VALIDATION.md` for
packaging commands and exact snapshot boundaries.

Main fixture: `loop-release-db-03p`, dedicated `loop_foundation_test`, explicitly
overridden DATABASE_URL and TEST_DATABASE_URL; container-local port5432. Commands:

```powershell
docker build --target validation -t loop-gpt-backend:validation-03p backend
docker run --rm --network container:loop-release-db-03p -e DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03p npm run migrate:deploy
docker run --rm --network container:loop-release-db-03p -e DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' -e TEST_DATABASE_URL='postgresql://loop_test:local-test-only@127.0.0.1:5432/loop_foundation_test?schema=public' loop-gpt-backend:validation-03p npm run test:integration
```

## Candidate-tree secret review

Gitleaks v8.28.0 runs locally with network disabled and full output redaction.
Both staged diff and the complete Git-index tree archived by `git archive` are
scanned; local ignored files and Git history are deliberately not scanned.

Initial findings were two exact synthetic offline Stripe fixtures, one prose false
positive, a public Cloudflare analytics site identifier, and a literal API key in
the legacy LibreChat spike configuration. The prose was clarified. `.gitleaks.toml`
permits only the exact synthetic values in their test file and the exact public
beacon identifier in the shipped gateway HTML, retaining all default scanner rules.
The legacy literal was replaced by `${LOOP_API_KEY}`; it was not allowlisted.

Final local scans returned **no leaks found** for both the staged diff (about
1.52 MB) and complete candidate-tree archive (about 2.82 MB). Only the exact
documented fixture/public identifier exceptions were used. The release diff at
that point contained 238 files; no unstaged or unexpected untracked source remained.
Main's owned `loop-release-db-03p` container was stopped and automatically removed;
pre-existing local services were not stopped.

The earlier tunnel credential remains removed from tracking and image COPY; its
local file was preserved. Both historical tunnel and backend credentials require
coordinated rotation/revocation; current validity was not tested. No history rewrite,
production credential mutation or service restart occurred. A clean candidate scan
does not erase historical exposure or guarantee all possible secrets are detected.

`release-secret-scan.yml` reproduces the complete candidate-tree scan in CI using
the scanner image digest, a read-only archive and no runtime network access.

## Release boundaries

Do not merge or cut over production from this candidate. New staging must use a
fresh database/PVC/secrets and prove attached-volume maintenance, readiness/API
ports, DNS/TLS, shutdown/rollback and actual client acceptance. Full payment
fulfillment, reconciliation, general task/sandbox execution, full product surfaces
and native Store/Direct delivery remain in `../PRODUCTION_CHECKLIST.md`.
