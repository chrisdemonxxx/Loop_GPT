# AUDIT — baseline evidence (Stage 1)

Method: commands executed, not assumptions. Master plan: unrestricted edition on HF infrastructure, reuse-first against the existing hardened stack (Express+Prisma backend, Next product UI, Expo mobile — overriding the prompt's default stack per its own "reuse before rebuilding" rule; the existing backend carries 992 tests, 12 migrations, durable ledgers, inbox payments, budgets, observability).

## Dead-code sweep (executed)
`rg "TODO|FIXME|HACK|XXX|not implemented" backend/src frontend/app mobile/src` (non-test):
- backend: **0 hits**
- frontend: **1 benign hit** — `app/account/page.tsx:134` redeem-code input placeholder (a legitimate input hint, not dead code)
- mobile: 0 hits

## Module status (Working = command/test evidence from this session or the validation chain)
| Module | Status | Evidence |
|---|---|---|
| Chat core: SSE streaming (chat/agent/research), persistence, daily ledger | Working | API E2E 25/25; browser E2E "BANANA" streamed, 0 page errors |
| /v1 developer API: models/pricing/chat/embeddings/usage | Working | E2E: WIRED, 384-dim embeddings, ledger 1.0→0.998803 |
| Auth: register/login (memory-only token), promote-admin CLI, admin gates | Working | E2E; `5e655c6` fixed verify-token-as-session bug |
| Private files: upload→attachmentId→vision answer; auth-gated content | Working | E2E sha256 round-trip; 401 anonymous |
| Generated artifact image/video display + download | **Broken** | ArtifactCard uses raw href on auth-only `/api/files/:id/content` → 401 (user-reported) |
| Composer attach menu | Duplicate | Three photo entries, different words (`Composer.tsx:157-160`) |
| Payments: durable inbox, exactly-once fulfillment, entitlements, refunds/disputes | Built, gated | 990 tests; honest 503 without keys |
| Budgets, observability ring, video accounting/queue, storage guards | Working | Live 429 cap demo; ring caught 2 real bugs this session |
| Sandbox / code execution | Missing | No container runtime wired to AgentComputer |
| Connectors / MCP / skills / plugins | Retired + not rebuilt | Global registries 410'd (03n security); workspace-scoped replacements absent — "dummy" verdict correct |
| Multi-agent fleet / research pipeline | Missing | No subagent orchestration |
| Projects, knowledge base, memory, styles, artifacts panel | Missing/Partial | Workspaces exist; no pgvector retrieval |
| Image gen / video gen (ref2lock) / prompt optimizer | Unprovisioned | Honest 503s; no endpoints; video schema lacks referenceImageId |
| Mobile (Expo Store+Direct) | Built, unsigned | Typecheck clean; EAS signing pending |
| UI design | Functional, not premium | User verdict: "boring" |

## Run status (executed)
Local full stack: backend on :3001 (Docker Postgres, 12 migrations, live HF endpoints), static export UI on :3000, API E2E 25/25, browser E2E pass. Mobile unverified-on-device (no emulator on this machine — honest limitation).
