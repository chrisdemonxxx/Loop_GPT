# Loop GPT — Project Status Report

**Date:** 2026-09-22
**Repository:** `loop-gpt` (Next.js static-export frontend + Express/Prisma backend, Postgres, Railway)
**Live site:** https://loop-gpt.cyou
**Latest deploys:** both services **SUCCESS** on the Railway production environment (`2faec73c-…`)
**Report scope:** an honest, factual accounting of what is built, what is not, and what still needs work.

---

## 0. TL;DR — Honest assessment

| Dimension | Status |
|---|---|
| **Product usable end-to-end** | **Yes.** Sign up, chat with the agent, attach files, use tools, see a live activity feed, create projects with knowledge, connect real apps (Notion/Slack/GitHub/Google…), and pay nothing. The single biggest pre-existing credibility gap (a grid of ~27 fake "OAuth setup required" cards) has been replaced with two real tiers: a default grid that actually connects and a marketplace that connects with user-supplied OAuth credentials. |
| **At frontier parity (Claude.ai / ChatGPT) on UX** | **Mostly, for the surfaces the brief listed.** Settings IA, composer modes/menu, slash palette, projects, agent activity feed, and voice (STT dictation + per-message TTS) all match the brief. The polish debt that remains is small (one accent vs. the existing neon-gradient class names in legacy CSS), not structural. |
| **Backend depth** | **Strong.** 19→21 schema migrations applied, 1041 unit/integration tests passing, OAuth 2.1+PKCE with per-workspace connection encryption, pgvector project knowledge, a durable research run engine, an artifacts system with version diff/publish, an Admin + Developer portal, full audit logging, account/redeem/billing flows. |
| **What's missing (this is the honest part)** | The brief lists "production-ready" and the gates are green, but the brief itself scoped out: mobile parity, full voice mode, PDF knowledge ingestion, nightly memory synthesis. Beyond the brief, there are real gaps that any real user will feel in week one: **no email / magic-link / social signup** (signup is open + email/password only), **no password reset in production**, **no payments live** (the billing system is built but Stripe is off in this env), **no observability/backups/load testing**, and the **mobile app is a stub** (Expo project exists but parity is GAP-070). |

The rest of this report is the structured version of that TL;DR.

---

## 1. What is fully built — and verified

Everything in this section has a real implementation, a real backend route, a real test, and (where applicable) is live on https://loop-gpt.cyou.

### 1.1 Foundations (pre-existing, kept + verified)

- **Auth** — signup, signin, JWT sessions, role-based access (`user` / `admin`), dev-mode passthrough for testing. (`routes/auth.ts`)
- **Chat core** — streaming SSE agent run (`routes/agent.ts` → `runAgentStream`), server file paths hardened against client-side path injection (`HOSTED_MODEL_REQUIRED` rejection, `attachmentId` instead of `imagePath`).
- **Token gating / metering** — daily message + image credits, reservation/settlement, free vs pro plan, **admin unlimited** exemption. (`services/billing.ts`)
- **Attachments** — image upload per conversation (up to 4 per turn), vision path.
- **Artifacts** — generated documents (PDF, DOCX, XLSX, CSV, MD, HTML), versioning with line-level diff, sandboxed iframe preview (`srcDoc sandbox=""`), view-only public publish with anonymous token URLs. (`routes/files.ts`, `ArtifactsPanel.tsx`)
- **Research** — 5-phase multi-agent fleet (flagship plan/synthesis, parallel fast sub-agents), citations, durable `ResearchRun` table decoupled from the response, progress/report API. (`services/researchRuns.ts`, `agent/deepResearch.ts`)
- **Skills** — SKILL.md + YAML-frontmatter format (the Anthropic Agent Skills open standard), built-in `PDF Report Writer` + `Spreadsheet Analyst`, config-store enabled/skills injected, **GET/PUT detail routes** (added in this overhaul) returning raw source, **`create_skill` meta-tool** so the model can build a skill from chat.
- **Plugins** — `text-utils` reference plugin with lifecycle, per-tool permission overrides, audit log bounded at 1000 entries.
- **MCP** — add/list/remove servers with HTTP (Streamable) and stdio transports, runtime status + per-server tool count surfaced in the connectors tab.
- **Projects** — pgvector-backed knowledge chunks, `search_knowledge` tool, project-scoped chats, dedicated 2-step creation flow with file upload (.txt/.md/.csv parsed client-side → `/ingest`).
- **Account & billing** — `/account` page with **voucher redemption** (`POST /api/account/redeem`), voucher code minted today (`LOOP-BFMMX-5M3JC`, type `unlimited`, capped at 5 teammates).
- **Workspace connections (encrypted)** — `WorkspaceConnection` table with `encryptedConfig` (AES via `services/credentialVault.ts`), separate from configStore connectors. Existing reviewed adapters for notion + gitlab.
- **Audit + Admin + Developer portals** — full `routes/admin.ts` (vouchers, users, agent extensions), audit log feed, Developer portal at `/developer`.

### 1.2 The UX/UI overhaul (this session — frontier parity)

Delivered end-to-end against the brief; all 14 acceptance items shipped. Built and shipped to production (Railway SUCCESS on both `backend` + `web`):

| § | Brief item | Delivery |
|---|---|---|
| 0 | Design system | `components/ui/primitives.tsx` — Card, Toggle, EmptyState, StatusDot, SearchInput, SectionHeader, Badge. Single accent `#c96442` reused across new surfaces. (Neon-gradient class names still exist in legacy CSS for legacy chrome — not removed, not bloomed.) |
| 1 | Builder tab removed | Tab + raw form deleted; capability preserved as a real **Custom / HTTP API** card in Connectors using the existing `/api/agent/custom-tools` backend. |
| 2 | Memory redesign | Migration `20260925000000_memory_source_toggle` adds `Memory.source` (`user`\|`agent`) + `User.memoryEnabled`. New routes `GET/POST /api/memory/enabled`. `getMemories` is gated on the user's toggle. UI: master toggle, search with result count, per-item edit (PATCH) + delete, **"you added" / "learned"** badges (source), tag grouping, real empty state. |
| 3 | Styles → Personalization | Tab renamed; preset gallery (Normal / Concise / Explanatory / Formal) selecting one writes it as default; create-your-own + **create-from-writing-sample** via new `POST /api/styles/from-sample` (shared `synthesizeStylePrompt` with the `generate_style` tool); Voice preferences section (voice + rate, consumed by TTS). |
| 4 | Connectors reality | Catalog split: **Available now** (14 key-based + platform OAuth incl. **Google Calendar + Sheets** with real tool adapters) + GitHub + Custom HTTP. **Marketplace** (8 providers — Outlook, OneDrive, Dropbox, Linear, Asana, Salesforce, Figma, Zoom — connect with **user-supplied OAuth app credentials**, real PKCE flow, generic `api_request` tool). **Key validation on save** (probe per provider) + **Test connection** per card (`POST /api/agent/connectors/:id/test`). MCP merged as **Advanced** section. Fixed a latent bug: OAuth'd connectors previously never appeared in Settings and registered no agent tools — callback now **dual-writes** a configStore entry + activates the adapter. |
| 5 | Skills | Detail view, **Edit source** (raw SKILL.md editor with frontmatter-aware parsing), create form with live SKILL.md preview, `create_skill` meta-tool wired for natural-language in-chat creation. |
| 6 | Model/BYOK removed | Tab, `getProviderSettings`, `aiProvider`/`aiModel`/`aiApiKey` localStorage keys, dead code in `chat/page.tsx` all purged. `HF_ENDPOINT_URL`/`HF_TOKEN` remain as **backend-only env** (correct — they're not end-user-facing). |
| 7a | Mode switcher | 4 modes (Auto / Plan / **Ask first** / Accept edits), icons + descriptions + visible active ring on collapsed button. New **Ask first** ("step mode") is real: `stepMode` stream input → `requiresInteractivePause` in `agentRuntime.ts` forces the approval gate on every tool, with `autoApprove` still disabling it. |
| 7b | "+" menu trimmed | Photos & files · Screenshot · Connectors · Create image + "Manage tools →" (Settings → Tools). Raw tool checklist removed. |
| 7c | Slash palette | Compact single-line rows, section headers (Create / Manage / Session / Help), hint on highlighted row only, **fuzzy subsequence filter**, keyboard nav fixed to state, new commands `/skills /projects /connectors /plugins`. |
| 7d | Voice | **STT dictation** via Web Speech API with live interim transcript, pulsing recording state, elapsed timer, cancel/stop-and-send (`lib/voice.ts useDictation`), feature-detected. **Per-message TTS** via `speechSynthesis` (markdown stripped for reading, play/pause/stop, voice prefs from Personalization). Full voice mode excluded per plan. |
| 8 | Projects | First-class sidebar section with inline recents + active highlight; Claude-style cards (chats/knowledge counts, last-active, instructions preview); dedicated two-step creation flow; prominent knowledge file upload (.txt/.md/.csv parsed client-side). |
| 9 | Chrome | Export button → **Markdown / PDF (print)** menu; ModelSelector restyled; artifacts panel verified. |
| 10 | Agent Computer redesign | 5 live status states (Idle / Thinking / Running tool / Waiting for input / Error) with animated pulse; **collapsible tool-call cards** (icon, args summary, timestamps, success/fail, expandable raw input/output in mono); step-grouped timeline; **clickable tool count** opens the tools list with a link to Settings → Tools; proper empty state; approval card restyled. |

### 1.3 Verification (today, on this checkout)

| Gate | Result |
|---|---|
| `backend: npm run build` | **0** (clean) |
| `backend: npm test` | **49 files · 1041 passed · 5 skipped** (one Tavily test is real-network-dependent and has been flaky under load — re-runs green; it is **not** a code regression) |
| `frontend: npx tsc --noEmit` | **0** (clean) |
| `frontend: npm run lint` | **0** exit (warnings only — pre-existing baseline unchanged) |
| `frontend: npm test` | **20 passed** (Composer + commands palette + Settings shell + Memory tab) |
| `frontend: npm run build` | **0** (16 static routes) |
| `npx playwright test` (axe a11y on `/`, `/login/`, `/signup/`, `/chat/`) | **12 passed** (previous run, in-session) |
| Prisma migrations | **21 / 21 applied** in production (`migrate status` → "Database schema is up to date!") |
| Railway deploys (backend + web) | Both **SUCCESS** in the production environment |
| Live site | `GET https://loop-gpt.cyou/healthz → 200`, `/chat/ → 200` |
| New API surface (live) | `/api/memory`, `/api/memory/enabled`, `/api/styles`, `/api/styles/from-sample`, `/api/agent/skills`, `/api/agent/skills/pdf-report`, `/api/agent/connectors` all return 401 (auth-gated, exist, not 404) |

### 1.4 Live data (today)

- 1 active voucher in production: **`LOOP-BFMMX-5M3JC`** — type `unlimited`, plan `pro`, **max 5 redemptions**, no expiry, 0 redeemed, active. Minted and capped in-session via a temporary Postgres TCP tunnel (now removed). Temp files deleted.

---

## 2. What is NOT yet built — honestly

These are the things I did not deliver in this session. Some are explicitly out of scope of the brief; others are pre-existing gaps the brief did not address but that any real user will notice. I'm marking them clearly.

### 2.1 Explicitly out of scope of the UX brief (but called out in the plan)

| Item | Note |
|---|---|
| **Mobile parity** (GAP-070) | The `mobile/` Expo app exists but does not mirror the new web IA / composer / settings. The web is responsive for tablet/phone viewports, but the native app is not. |
| **Full voice mode** (hands-free, continuous mic + spoken replies) | Baseline STT dictation + per-message TTS shipped per plan. Continuous voice mode would require backend audio streaming (out of plan). |
| **PDF knowledge ingestion** (GAP-041) | Knowledge uploads accept `.txt/.md/.csv` (client-side parse). PDF ingestion would need a backend text-extraction pipeline (pdf-parse / Tika) — not built. |
| **Nightly memory synthesis** (GAP-044) | The schema + source distinction (`user` vs `agent`) and the toggle ship today — so when the agent learns something in chat via `remember`, it shows up with the "learned" badge. The nightly batch that synthesizes preferences from conversations is **not built**. |
| **`/agents` slash command** | The brief conditions this on multiple agent personas existing. They don't, so the command isn't there. |

### 2.2 Pre-existing gaps the brief did not address (the honest list)

This is what I would flag if you asked me to write a real onboarding checklist. Not built in this session; some not built ever.

**Auth & identity**
- **No email verification in production.** Signup just creates the account (`POST /api/auth/signup`). `User.emailVerified` defaults to `false`. No email is sent.
- **No password reset in production.** `routes/auth.ts` exists for `/api/auth/reset`, but no SMTP is wired, so the link is never delivered.
- **No magic-link / OAuth sign-in in production.** `/api/auth/providers` is stubbed (`{ providers: [], guest: false }`).
- **No TOTP MFA** (GAP-042).

**Payments**
- **Stripe is disabled in this environment** (`STRIPE_CHECKOUT_ENABLED=false`, `STRIPE_FULFILLMENT_ENABLED=false`). The billing system + `User.stripeCustomerId` + `stripeSubId` fields are wired, but no checkout flow runs here.

**Email / notifications**
- **No SMTP / Resend configured.** `services/email.ts` exists with `voucherRedeemedEmail` etc., but the transport is dev-only. Account confirmation, reset, etc. never actually send.

**Observability + ops**
- **No backups / monitoring / load testing** (GAP-057). The DB is a single Postgres instance; no read replica, no point-in-time recovery, no alerting.
- **No Sentry / PostHog / log shipping** (GAP-054).
- **Single GPU consolidation** (GAP-058) — current config assumes one HF inference endpoint per role; no pooled provisioning.

**Research parity**
- **No shared scratchpad table** (GAP-046). Research uses in-process state between sub-agents; a durable scratchpad would let resumes pick up after restarts.
- **IndexedDB drafts** (GAP-045) — composer doesn't persist local drafts.
- **No context meter / compaction / extended-thinking display / message branching** (GAP-045).
- **No incognito chats** (GAP-045).

**Memory**
- **Nightly synthesis** (already noted above).

**Skills / plugins**
- **No versioning** (GAP-048). Skills overwrite in place; no install/update lifecycle.
- **No plugin marketplace / lifecycle** beyond the reference `text-utils` (GAP-015).

**Projects**
- **No live "0 knowledge chunks" → upload affordance in the empty card body** — the prominent upload button only appears after opening per-project knowledge section. Acceptable but not as discoverable as the brief implied. (Quick win for a follow-up.)

**Connectors**
- **Connector tests are best-effort.** The validation probe rejects bad credentials (401/403), but providers that return 200 for auth-less probes (some SaaS return 200 with a redirect HTML) could pass while being invalid. Real connector onboarding should always be followed by a manual test.
- **The 8 marketplace providers** require users to create their own OAuth app + paste credentials. That is the honest answer to "not dead cards" but it shifts setup cost to the user. Some providers (Salesforce, Microsoft Entra) need extra config the README should cover.
- **No live provider E2E tests** against the wired providers (GAP-068 partial). Manual checks only.

**Mobile**
- **No native signing** (GAP-049).
- **Mobile parity** (GAP-070) — see above.

**Files / artifacts**
- **Non-image attachments beyond image/PDF** (GAP-041) — image upload works; PDF + DOCX + XLSX + CSV + MD are generated but only images can be uploaded as conversation attachments.
- **Stale docs flagged in GAP-062** (`PROVIDER_MEDIA_HTTP.md`, `/api/models/selection` references in `RUNTIME_AUTHORIZATION.md` / `BUILD_PROGRESS.md`, `ACCOUNTED_VIDEO_JOBS.md` path).

**Admin / Developer**
- **The Developer portal** exists at `/developer` but the Admin portal has no polished UX; both rely on the live API.

### 2.3 What I personally don't trust yet (the "I would test this manually before customers see it" list)

These aren't broken; I just want a human to touch them once:

1. **Google OAuth end-to-end** — the new dual-write + token-refresh path is only verified via the unit suite's mock setup. A live Google Drive/Gmail/Calendar/Sheets OAuth round-trip in the real env has not been exercised this session.
2. **Marketplace providers** — none of the 8 user-OAuth-app flows have been live-tested.
3. **Step mode ("Ask first")** — the gate logic is unit-tested via `requiresInteractivePause`, but the end-to-end behavior (tool blocked until approved, every tool, with multi-step turns) has not been run with a real model.
4. **The voice loop** — STT dictation only renders in Chrome/Edge/Safari; per-message TTS voice selection depends on installed OS voices; the baseline works but the experience varies wildly per browser.
5. **Skill create via chat** — the `create_skill` meta-tool is registered; I have not seen the model actually use it to produce a working skill end-to-end.

---

## 3. What still needs work — prioritized

### P0 — Do this before a public launch

1. **Auth that's actually auth.** Wire Resend (SMTP is in the code; just needs env). Enable email verification, password reset, magic link / social sign-in. Without these, signup creates orphans.
2. **Stripe live** (or an explicit "free tier only" decision and an updated landing page). The billing engine is ready; flipping it on needs env + Stripe webhook URL.
3. **Real connector smoke run.** Pick Drive + Calendar + Figma (marketplace), exercise the full OAuth → configStore dual-write → test connection → tool call round-trip. Fix anything that breaks.
4. **Backups + monitoring.** The DB has no backups, no alerting, no log shipping. One incident away from "we lost everything".
5. **Set `ADMIN_INVITE_CODE`** in production env (the env-based team code path is already implemented in `services/billing.ts:154`).

### P1 — Important for a respectable product

6. **Mobile parity** (GAP-070) — at minimum the chat + settings + projects on the Expo app.
7. **PDF / DOCX / XLSX / CSV ingestion** for knowledge + attachments (GAP-041).
8. **Nightly memory synthesis** (GAP-044).
9. **Skill/plugin lifecycle + versioning** (GAP-015 / GAP-048).
10. **IndexedDB drafts + context meter + extended-thinking display** (GAP-045).
11. **Shared scratchpad table** for research (GAP-046).

### P2 — Polish + longer-term

12. **Memory incognito + project-scoped drafts.**
13. **TOTP MFA** (GAP-042).
14. **Read-aloud using the backend Kokoro TTS** (Kokoro `speak_text` tool exists; per-message UI uses browser `speechSynthesis` because there's no streaming endpoint yet). Higher quality + consistent voices once the backend adds a stream endpoint.
16. **Full voice mode** (continuous mic + spoken replies).
17. **Research resume / branching / message branching** (GAP-045).
18. **Connector tests as real CI** against a stub of each provider (Drive, Figma, Linear, etc.).
19. **Polish the Admin + Developer portals.**
20. **A real onboarding checklist / docs page** — the README and PROGRESS.md are internal; users need a "what to try first" page.
21. **Update / clean the stale docs** flagged in GAP-062.

### P3 — Hygiene

22. Fix the flaky Tavily test (`src/agent/__tests__/webConsumers.test.ts` times out under contention — inject a fixture server in CI).
23. Single source of truth for the "Model" tier — currently the model picker UI uses `Large Looper` / `Small Looper` while the backend has its own `large` / `standard` tier naming. Align them.
24. Resolve the leftover neon-gradient class names in legacy CSS (`neon-violet`, `neon-cyan`, `neon-green`, `neon-fuchsia`) vs the new single-accent design language. Either retire or deliberately retain.
25. **Commit** the working tree (everything is uncommitted). I've been deferring this per the "only commit when explicitly requested" rule; just say the word.

---

## 4. Where the codebase is right now — file-level inventory

High-signal directory map of what shipped this session and what was already there.

```
loop-gpt/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma                       (updated: Memory.source, User.memoryEnabled)
│   │   └── migrations/
│   │       └── 20260925000000_memory_source_toggle/migration.sql   (NEW — applied live)
│   └── src/
│       ├── agent/
│       │   ├── agentRuntime.ts                  (stepMode + requiresInteractivePause helper)
│       │   ├── types.ts                         (RunAgentOptions.stepMode)
│       │   ├── skills/skillLoader.ts            (getSkillSource, updateUserSkill)
│       │   ├── tools/remember.ts                 (source: 'agent', enable gate)
│       │   └── connectors/                      (NEW structure)
│       │       ├── catalog.ts                   (PLATFORM_OAUTH split, probeConnector)
│       │       ├── oauthProviders.ts            (NEW — provider metadata + marketplace registry)
│       │       ├── googleAdapters.ts            (NEW — Drive/Gmail/Calendar/Sheets tools + refresh)
│       │       ├── marketplaceAdapters.ts       (NEW — generic api_request + probe)
│       │       └── connectorRegistry.ts         (Google + marketplace registered, listTypes filters)
│       └── routes/
│           ├── agent.ts                         (skills GET/PUT, connectors marketplace + test, stepMode)
│           ├── memory.ts                        (NEW endpoints: /enabled + source in create)
│           ├── styles.ts                        (NEW POST /from-sample)
│           └── oauthConnector.ts                (rewritten — dual-tier + dual-write)
├── frontend/
│   └── app/
│       ├── components/
│       │   ├── SettingsPanel.tsx                (rewritten — new IA, 6 tabs, no Builder/Model)
│       │   ├── ui/primitives.tsx                (NEW shared primitives)
│       │   ├── settings/                        (NEW directory — 6 tabs)
│       │   │   ├── MemoryTab.tsx
│       │   │   ├── PersonalizationTab.tsx
│       │   │   ├── SkillsTab.tsx
│       │   │   ├── ConnectorsTab.tsx            (largest — Available + Marketplace + MCP Advanced)
│       │   │   ├── PluginsTab.tsx
│       │   │   └── ToolsTab.tsx
│       │   ├── settings/__tests__/SettingsTabs.test.tsx   (NEW)
│       │   ├── AgentComputer.tsx                (rewritten — 5 states + collapsible cards + clickable tool count)
│       │   ├── ProjectsPanel.tsx                (rewritten — cards + 2-step creation + knowledge upload)
│       │   ├── chat/Composer.tsx                (rewritten — 4 modes + trimmed + menu + mic + palette)
│       │   ├── chat/MessageList.tsx             (per-message TTS read-aloud added)
│       │   ├── chat/Sidebar.tsx                 (Projects section added)
│       │   └── chat/ActivityPanel.tsx           (onOpenTools pass-through)
│       ├── lib/
│       │   ├── api.ts                           (ProviderSettings removed)
│       │   ├── commands.ts                      (rewritten — sections + fuzzy + new commands)
│       │   ├── stream.ts                        (stepMode added)
│       │   ├── voice.ts                         (NEW — useDictation + useSpeech hooks)
│       │   └── i18n.tsx                         (NEW keys for mic/TTS/modes/marketplace)
│       └── chat/page.tsx                        (BYOK removed; stepMode sent; export menu; live timestamps; sidebar projects props)
└── docs/
    ├── PROGRESS.md                              (UX overhaul section added)
    └── GAP_REGISTER.md                           (GAP-014/019/021/022 status updated)
```

**Everything above is uncommitted in the working tree** (no `git commit` was performed — I defer to explicit instruction per repo policy).

---

## 5. Deploy + live state

| Item | State |
|---|---|
| Railway project | `loop-gpt-owned-staging-20260917` (`8584f5ac-…`) |
| Environment | production (`2faec73c-…`) |
| Migrations applied | 21 / 21 (incl. `memory_source_toggle`) |
| Backend deploy | **SUCCESS** — `4bc8d358-…` at `2026-09-22T04:11:19Z` |
| Web deploy | **SUCCESS** — `cd5c8ac2-…` at `2026-09-22T04:12:38Z` |
| Live site | `GET /healthz → 200`, `/chat/ → 200` |
| New routes probed live | All return 401 (auth-gated, exist) |
| Active voucher | `LOOP-BFMMX-5M3JC` — `unlimited`, `pro`, **5 redemptions**, no expiry, 0 redeemed |
| Temp infra cleaned | TCP proxy removed, `rwvars*.json`/`voucher-*.cjs` deleted |

---

## 6. How to verify the claim "production-ready"

In order of cost (cheapest first):

1. **Open the live site** at https://loop-gpt.cyou — sign up, hit Settings, walk through the 6 tabs. Every screen should look like the brief.
2. **Run the local gates** (the same ones I ran):
   ```
   cd backend  && npm run build && npm test
   cd frontend && npx tsc --noEmit && npm run lint && npm test && npm run build && npx playwright test
   ```
3. **Curl the new API surface** (all should be 401):
   ```
   curl -s -o /dev/null -w "%{http_code}\n" https://loop-gpt.cyou/api/memory
   curl -s -o /dev/null -w "%{http_code}\n" https://loop-gpt.cyou/api/memory/enabled
   curl -s -o /dev/null -w "%{http_code}\n" https://loop-gpt.cyou/api/styles
   curl -s -o /dev/null -w "%{http_code}\n" https://loop-gpt.cyou/api/styles/from-sample
   curl -s -o /dev/null -w "%{http_code}\n" https://loop-gpt.cyou/api/agent/skills
   curl -s -o /dev/null -w "%{http_code}\n" https://loop-gpt.cyou/api/agent/connectors
   ```
4. **Redeem the voucher** with a teammate's account at `/account` — should immediately grant unlimited + pro.

---

## 7. Closing note — what I would not say if I were being promotional

The product is **demoable end-to-end**. It is **not** launchable to a paying audience without at minimum:
- real email/auth (P0 #1),
- live payments or an explicit free-only mode (P0 #2),
- a single live connector smoke run for the new OAuth + marketplace paths (P0 #3),
- backups on the database (P0 #4).

Everything beyond that is polish. The UX overhaul this session did exactly what it was scoped to do; the items it deliberately left out are flagged honestly above so they aren't a surprise later.
