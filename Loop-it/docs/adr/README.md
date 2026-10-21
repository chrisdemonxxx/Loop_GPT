# Architecture Decision Records

Every locked decision in `PLAN.md` §1 has an ADR. Any change to a decision or to an invariant
(I1-I12) requires a new ADR that supersedes the old one - never an in-place edit.

Use [`TEMPLATE.md`](./TEMPLATE.md) for new records.

| ADR | Title | Status | Invariants |
|---|---|---|---|
| [0001](./0001-monorepo-with-pnpmturborepo-and-uv-workspaces.md) | Monorepo with pnpm/Turborepo and uv workspaces | Accepted | none |
| [0002](./0002-fastify-+-trpc-+-openapi-for-the-control-plane-api.md) | Fastify + tRPC + OpenAPI for the control-plane API | Accepted | I1, I10 |
| [0003](./0003-temporal-as-the-durable-workflow-engine.md) | Temporal as the durable workflow engine | Accepted | I7, I12 |
| [0004](./0004-python-for-the-orchestrator-workers-and-agent-harness.md) | Python for the orchestrator workers and agent harness | Accepted | I1 |
| [0005](./0005-adopt-openhands-codeact-in-phase-0-1-replace-the-loop-by-phase-3.md) | Adopt OpenHands (CodeAct) in Phase 0-1, replace the loop by Phase 3 | Accepted | I1, I6 |
| [0006](./0006-vllm-as-the-serving-engine-never-tgi.md) | vLLM as the serving engine; never TGI | Accepted | I5 |
| [0007](./0007-litellm-behind-our-own-router-svc.md) | LiteLLM behind our own router-svc | Accepted | I5 |
| [0008](./0008-buy-a-managed-firecracker-sandbox-provider-now-evaluate-self-hosting-in-phase-4.md) | Buy a managed Firecracker sandbox provider now; evaluate self-hosting in Phase 4 | Accepted | I1, I2, I3, I4 |
| [0009](./0009-default-deny-egress-through-a-logging-forward-proxy.md) | Default-deny egress through a logging forward proxy | Accepted | I3, I4 |
| [0010](./0010-cow-checkpoints-persisted-off-the-sandbox-vm.md) | CoW checkpoints persisted off the sandbox VM | Accepted | I1 |
| [0011](./0011-one-opinionated-generated-app-stack-reactvitetailwind-+-postgresauthstorage.md) | One opinionated generated-app stack: React/Vite/Tailwind + Postgres/auth/storage | Accepted | I9 |
| [0012](./0012-playwright-for-in-sandbox-browser-verification.md) | Playwright for in-sandbox browser verification | Accepted | I1, I8 |
| [0013](./0013-vault-for-secrets-with-scoped-just-in-time-injection.md) | Vault for secrets with scoped just-in-time injection | Accepted | I2 |
| [0014](./0014-opentelemetry-plus-an-append-only-audit-log-with-a-worm-mirror.md) | OpenTelemetry plus an append-only audit log with a WORM mirror | Accepted | I10 |
| [0015](./0015-semgrep-gitleaks-and-dependency-audit-as-verification-layer-l25.md) | Semgrep, gitleaks, and dependency audit as verification layer L2.5 | Accepted | I9 |
| [0016](./0016-stripe-for-payments-with-our-own-credit-ledger-as-source-of-truth.md) | Stripe for payments with our own credit ledger as source of truth | Accepted | I12 |
| [0017](./0017-terraform-helm-and-canary-rollouts-with-one-click-rollback.md) | Terraform, Helm, and canary rollouts with one-click rollback | Accepted | none |
| [0018](./0018-row-level-security-is-generated-structurally-not-requested-by-the-agent.md) | Row-level security is generated structurally, not requested by the agent | Accepted | I9 |
| [0019](./0019-staged-path-to-vault-encrypted-postgres-secret-store-first.md) | Staged path to Vault: encrypted Postgres secret store first | Accepted | I2, I10 |
