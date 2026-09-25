# DECISIONS

## D-001 — Flagship model (approved "go" on the recommendation)
**Decision:** keep the live `s-zaizen/DeepSeek-V4.1-Flash-Abliterated` endpoint as flagship (zero migration, already E2E-verified). Add the org-owned `redkits/GLM-5.3-ABLITERATED-FP8` as a second selectable flagship later (new endpoint deploy).
**Reasoning:** reuse-first; the endpoint is deployed, billed, and verified. Swapping now would trade a verified production path for a fresh deploy with no feature gain.

## D-002 — Image model
**Decision:** investigate `redkits/flux-h3-chain` (org-owned, gated, text-to-image) at GAP-004 build time; if unsuitable for image+text→image, pin the best uncensored FLUX.1-Kontext fine-tune resolved from the Hub, and record the pin here.
**Reasoning:** the master prompt prefers unrestricted image+text→image (Kontext-style); org-owned assets take precedence per reuse-first.

## D-003 — Guardrails scope with unrestricted models
**Decision:** the unrestricted/abliterated models are the explicit product choice for this deployment (master prompt: "UNRESTRICTED EDITION... restores the UNRESTRICTED choices as originally requested"). The existing guardrails module is scoped to abuse-prevention only (illegal-content/abuse/rate protections), not refusal or safety filtering. No reviewer-specific behavior.
**Reasoning:** user-confirmed product direction, consistent with the Direct-edition plan; recorded per the master prompt's evidence rules.

## D-004 — Stack alignment
**Decision:** keep the hardened Express+Prisma backend, Next product UI, and Expo mobile as the spine; layer every GAP on top. The master prompt's default stack (Next route handlers, Drizzle, Redis/BullMQ) is overridden by its own "reuse before rebuilding" rule — the existing backend carries 992 tests, 12 migrations, durable ledgers, payments inbox, budgets, and observability, verified end-to-end this session.
**Reasoning:** replacement would discard the most-validated asset in the repo with no functional gain.

## D-005 — Verification honesty
**Decision:** every "Working" claim cites a command/test (master prompt rule). Full visual verification of GAP-001's artifact rendering lands when the image endpoint is provisioned (GAP-004); until then it is verified at the code-path and build level, never claimed as visually proven.
