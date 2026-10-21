# Loop-it stack template: `react-postgres`

This is the **one** supported Loop-it application stack. The platform supports
exactly one stack on purpose: verification, the SAST rules, and the sandbox image
are all tuned to it. Every generated app starts as a copy of this directory.

- **Frontend:** React 18 + TypeScript + Vite
- **Backend:** Node 20 + TypeScript + Express
- **Database:** PostgreSQL via [`pg`](https://node-postgres.com/), parameterised
  queries only
- **Auth:** JWT bearer tokens, verified server-side on every request

## File tree

```
react-postgres/
├─ .env.example              # server + VITE_ client config; no real values
├─ index.html                # Vite entry
├─ package.json              # standalone; NOT a pnpm workspace member (see below)
├─ tsconfig.json             # shared strict compiler options
├─ tsconfig.server.json      # Node build of src/server
├─ tsconfig.client.json      # DOM/JSX build of src/client
├─ vite.config.ts            # envPrefix: 'VITE_' — the client secret allowlist
├─ vitest.config.ts
├─ migrations/
│  ├─ 0001_bootstrap.sql     # app_user role + auth schema + auth.uid()
│  └─ 0002_tasks.sql         # emitted verbatim by packages/provision (do not edit)
├─ scripts/migrate.mjs       # applies migrations in order as app_user
└─ src/
   ├─ server/
   │  ├─ config.ts           # server-only env; never forwarded to the browser
   │  ├─ db.ts               # the ONE query helper + withIdentity() transaction
   │  ├─ auth.ts             # JWT signature verification + algorithm allowlist
   │  ├─ security.ts         # helmet + CORS allowlist + auth rate limit
   │  ├─ errors.ts           # error handler that never leaks internals
   │  ├─ app.ts              # wiring
   │  ├─ index.ts            # process entry
   │  ├─ routes/
   │  │  ├─ tasks.ts         # the example per-user CRUD feature
   │  │  └─ session.ts       # identity introspection (auth-limited)
   │  └─ tests/
   │     ├─ auth.test.ts     # signature, alg:none, alg confusion, expiry
   │     └─ db.test.ts       # query helper refuses non-parameterised use
   └─ client/
      ├─ config.ts           # reads only VITE_-prefixed vars
      ├─ api.ts              # sends the bearer token; holds no secrets
      ├─ App.tsx
      └─ main.tsx
```

## Invariants a generated app MUST preserve

These are not style preferences. They are the reason the template is safe by
default; breaking one reintroduces an entire threat class from
`docs/08-security-and-abuse-playbook.md` (threat class 3: app-level vulns).

1. **Every DB query is parameterised.** `src/server/db.ts` is the only way to run
   SQL, and it takes `(text, values[])` as separate arguments. There is no helper
   that accepts a single interpolated string, because a template that makes
   concatenation convenient will get concatenation — and concatenated SQL is SQL
   injection. Never build SQL with template literals or `+`.

2. **Identity is propagated for row-level security; it is not re-implemented in
   `WHERE` clauses.** The app connects as `app_user` (never the table owner, so
   `FORCE ROW LEVEL SECURITY` actually applies). `withIdentity()` opens a
   transaction and, as its first statement, sets `request.jwt.claims` from the
   **verified** JWT via `set_config(..., true)` (LOCAL — scoped to that one
   transaction). The RLS policies emitted by `packages/provision` read
   `auth.uid()` and `current_setting('request.jwt.claims', true)::jsonb ->>
'org_id'`, so identity **must** be set in the same transaction as the query.
   RLS is the backstop that stops cross-tenant reads; the app's job is to
   propagate identity correctly, or every query correctly returns zero rows.

3. **No secrets in client code.** Only `VITE_`-prefixed variables reach the
   browser (enforced by `vite.config.ts` `envPrefix`). Server secrets are read
   from the environment in `src/server/config.ts` and never forwarded to the
   client. `.env.example` contains no real values.

4. **The JWT signature is verified on every request** (`src/server/auth.ts`). The
   middleware never trusts a decoded payload; it rejects missing, expired, and
   invalid tokens, and passes an explicit **algorithm allowlist** to
   `jwt.verify`, which is what defeats `alg: none` and algorithm-confusion
   attacks. `none` can never enter the allowlist.

5. **Security headers, CORS, and rate limiting stay on.** `helmet` sets the
   header bundle; CORS uses an **explicit origin allowlist** and never `*` with
   credentials; auth-sensitive endpoints are rate limited.

6. **Errors never leak internals.** Clients get an opaque status + message; stack
   traces and driver errors are logged server-side only
   (`src/server/errors.ts`).

## Migrations

`0002_tasks.sql` is emitted **verbatim** by the provisioning generator — do not
hand-edit it. Regenerate from the table specification:

```powershell
$env:PYTHONPATH="packages/provision/src"
python -c "from loopit_provision import ColumnSpec, TableSpec, emit_migration; print(emit_migration([TableSpec('tasks',(ColumnSpec('title','text',nullable=False),ColumnSpec('done','boolean',nullable=False,default='false')),access='owner')]))"
```

`0001_bootstrap.sql` creates the `app_user` role and the `auth.uid()` function
(GoTrue/PostgREST convention: the current user id is read from the verified JWT
claims, `request.jwt.claims ->> 'sub'`). It must run before any table migration.

## Why this template is NOT a pnpm workspace member

The repo's `pnpm-workspace.yaml` globs are `apps/*`, `packages/*`, `services/*`,
and `evals/*` — `stack-templates/*` is deliberately excluded, and
`eslint.config.mjs` ignores `stack-templates/**`. That is intentional and this
template keeps it that way:

- A stack template is **scaffolding copied into generated projects**, not platform
  code. Its dependencies (`react`, `express`, `pg`, …) belong to the _generated
  app_, not to the control-plane build. Pulling them into the root install and
  into `turbo run build`/`lint` would couple platform CI to app scaffolding and
  bloat the root dependency graph.
- Its `tsconfig` is self-contained (it does **not** extend the repo base) because
  once copied into a generated project the repo root no longer exists.

Because it is standalone, it carries its own `package.json` and is validated on
its own:

```powershell
cd stack-templates/react-postgres
npm install
npm run typecheck   # tsc --noEmit for both server and client
npm run test        # vitest
```

The repo-root `pnpm -w build`/`lint` and `python scripts/check_invariants.py`
continue to pass unchanged, because nothing here is part of the workspace.

## Local development

```powershell
cp .env.example .env   # then edit — never commit .env
npm install
npm run migrate        # requires a reachable Postgres and app_user role
npm run dev:server     # Express API on :8080
npm run dev:client     # Vite dev server on :5173
```

> The database path (migrations, RLS enforcement, the `withIdentity` transaction)
> requires a running PostgreSQL and cannot be exercised without one. The unit
> tests cover the auth middleware and the query helper without a database.
