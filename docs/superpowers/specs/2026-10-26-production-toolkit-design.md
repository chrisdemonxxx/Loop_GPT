# Production-Readiness Agent Toolkit — Design

Date: 2026-10-26
Status: Approved (design), pending spec review

## Goal

Equip Cursor with the plugins, MCP servers, and agent skills needed to take every
loop-gpt surface from half-done to shipped: map the gaps, fill and fix them, verify
features end to end, and release safely.

## Scope

All surfaces in this repo:

| Surface | Stack |
|---|---|
| `apps/web` | Next.js, Vitest, Playwright + axe, Storybook, Sentry browser SDK, PostHog |
| `backend` | Express, Prisma, Stripe, Sentry node SDK |
| `Loop-it` | FastAPI services, raw `psycopg` 3 (no SQLAlchemy/Alembic), E2B sandboxes |
| `mobile` | Expo / React Native |
| `apps/desktop` | Electron + electron-builder |
| `apps/extension*`, `packages/browser-extension` | Browser extensions |
| `deploy`, `infra` | Docker, Cloudflare tunnel, owned staging, E2B templates |
| CI | GitHub Actions (validation workflows, CodeQL, secret scan) |

Out of scope: changing application code. This spec covers tooling only; the gap map
it produces feeds later, separate plans.

## Constraints

- Free or free-tier only; OAuth sign-ins are acceptable; anything paid needs explicit approval.
- Already installed and excluded: Superpowers, shadcn, Stripe, Figma, Context.dev, Apify, AWS core.
- Marketplace plugins can only be added by the user (`/add-plugin <name>` or the marketplace UI).
  The agent installs skills and CLI-configured MCP servers itself.

## Components

### A. Cursor marketplace plugins (user profile)

| Plugin | Role | Sign-in |
|---|---|---|
| `agent-compatibility` (Cursor) | Gap map: audits startup, validation, and docs against reality | none |
| `thermos` (Cursor) | Deep branch security/correctness review | none |
| `cursor-team-kit` (Cursor) | CI, review, shipping, verification workflows | none |
| `playwright` (Cursor) | Real-browser feature verification and E2E tests | none |
| `github` | Repos, issues, PRs, Actions failures | GitHub OAuth |
| `sentry` | Instrumentation, source maps, alerts | Sentry free tier |
| `posthog` | Feature flags, error tracking, session replay | PostHog free tier |
| `prisma` | Prisma schema, migrations, upgrades for `backend` | none |
| `semgrep` | SAST, secrets, supply-chain scanning via hooks + MCP | Semgrep free tier |
| `snyk` | Dependency health and vulnerability fixes | Snyk free tier |
| `docker` | Dockerfile, Compose, sandbox guidance | none |
| `cloudflare` | Tunnel / Workers / platform guidance + MCP | Cloudflare OAuth |

### B. Context7 (user profile)

Installed with `npx ctx7 setup --cursor` for current library documentation. Free tier, OAuth.

### C. Vetted skills (project, `.cursor/skills/`, committed)

| Source | Skills | Trust |
|---|---|---|
| `mattpocock/skills` | `tdd`, `grill-me` | high (~304k stars) |
| `vercel-labs/agent-skills` | `vercel-react-best-practices`, `web-design-guidelines`, `vercel-composition-patterns` | high (~33k stars) |
| `expo/skills` | `expo-overview` plus the free framework skills and EAS deploy skills | high (official) |
| `OWASP/secure-agent-playbook` | `code-review-security` and the web/mobile/IaC review skills | medium-high (OWASP) |

### D. Low-trust community skills (project, gated)

| Source | Skill | Trust | Gate |
|---|---|---|---|
| `full-stack-skills/electron-skills` | `electron` only | low (7 stars) | Manual read before install |
| `Nordic-AI/production-readiness-skills` | `production-readiness` and its sub-audits | low (2 stars, last push Apr 2026) | Manual read before install |

Gate rule: read every `SKILL.md` and bundled script before writing it into the repo.
Reject a skill if it contains prompt-injection text, remote-execution commands
(`curl | sh`, `iwr | iex`), telemetry/exfiltration, or instructions that override
user or safety rules. Rejected skills are reported, not silently dropped.

### E. Custom project skill: `loopit-fastapi`

Written from the real `Loop-it` code instead of using a mismatched community skill. Covers
service layout under `Loop-it/services` and `Loop-it/packages`, FastAPI routing conventions,
`psycopg` 3 connection and query patterns used in `packages/store`, and how services are
validated (`loopit-validation.yml`). Content comes only from code observed in the repo.

## Data flow

1. The user adds plugins (A) and completes sign-ins; the agent installs B, C, D, and E.
2. The `agent-compatibility` scan produces a gap map for each surface.
3. Later plans use the toolkit: Playwright and Vitest to verify features, Sentry and PostHog
   for runtime signals, Semgrep, Snyk, and `thermos` before merge, `cursor-team-kit` and
   GitHub for CI and shipping.

## Error handling

- An install that fails is retried once with the vendor's documented alternative command,
  then reported with the exact error; the remaining items still proceed.
- A sign-in that the user hasn't completed leaves that MCP marked "needs auth"; that isn't
  treated as failure.
- A skill rejected at the gate is listed with its reason.

## Verification (definition of done)

- Every skill in C, D (accepted), and E is present under `.cursor/skills/<name>/SKILL.md`
  with valid frontmatter (`name`, `description`).
- Context7 appears in Cursor's MCP list.
- Each plugin in A is confirmed installed by the user, with its MCP connected or flagged
  "needs auth".
- One `agent-compatibility` dry run completes on this repo and its output is saved under
  `docs/superpowers/` for the follow-up plans.
