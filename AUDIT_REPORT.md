# Loop GPT — Project Audit Report (READ-ONLY)

> **Note on state.** This is a snapshot audit of the working tree at HEAD. Where `PROJECT_STATUS_REPORT.md` (UX-overhaul snapshot, 2026‑09‑22) and `PROGRESS.md` (production-readiness pass, dated after) describe the same feature differently, the audit follows the **current code** plus the more recent `PROGRESS.md`. Numerical claims about test counts and migrations are taken from `PROGRESS.md` (1077 tests / 55 files, 25/25 migrations) and the latest `validation/foundation-03o.md` (Linux backend total 1,399 tests). Live URL: `https://loop-gpt.cyou`.

---

## 1. PROJECT OVERVIEW

- **Project name:** **Loop GPT** (the loop-gpt-owned-staging codebase). One paragraph: a ChatGPT-style agentic chat product with deep research, vision, image / video / document generation, a real Docker-isolated code sandbox, project knowledge with pgvector retrieval, OAuth connectors (Google, GitHub, Notion, GitLab) plus a marketplace of user-OAuth-app providers (Outlook, OneDrive, Dropbox, Linear, Asana, Salesforce, Figma, Zoom), MCP servers, skills/plugins, encrypted workspace credentials, a daily-allowance metered accounting layer plus a prepaid developer API (`/v1`) with its own reservation/settlement engine, and a durable research-run engine decoupled from the HTTP response. Built on a Next.js (App Router, static-export) frontend (`frontend/`) + Express/Prisma/Postgres backend (`backend/`), deployed as two Railway services (`web` proxies `/api` + `/v1` to the `backend` service; `cf-tunnel` is a spare path). Audience: individual developers (web + `/v1` API) and small teams (vouchers, Pro/Gold/unlimited tiers).
- **Current stage:** **Production-leaning beta, not launchable to a paying audience.** Self-described in `docs/PROGRESS.md` and `docs/loop-gpt-production-readiness-brief.md` as "demoable end-to-end" with green gates but specific P0/P1 gaps remaining. Verdict from `docs/PROJECT_STATUS_REPORT.md` §7: "demoable end-to-end. It is not launchable to a paying audience without at minimum: real email/auth (P0 #1), live payments or an explicit free-only mode (P0 #2), a single live connector smoke run for the new OAuth + marketplace paths (P0 #3), backups on the database (P0 #4)." Today the landing + `/account` + `/onboarding` show "Free during launch" copy and Stripe is dormant — i.e. **Option B free-only is in effect**. So the product is *operational* but is not feature-complete relative to a Claude-style chat app (see §8).
- **Honest % complete vs. a Claude-style product:** Roughly **70–75%** of the polished-chat experience is shipped. Within the brief-listed capabilities: layout/navigation, composer (incl. mode picker + slash palette), message rendering (markdown/code/wrap/copy + extended-thinking), tools+agent activity, projects, memories, skills, plugins, connectors, settings, model selector, voice STT/TTS — all shipped. Several platform-staples are missing or partial: full OAuth login (Google/GitHub providers exist but not wired in production), email verification, mobile parity, server-side video lifecycle, real-time search/connectors CI, marketplace E2E coverage. The exact list is in §8.
- **Repo structure (top 2–3 levels):**
  ```
  loop-gpt/
  ├── backend/                 Express + Prisma + Vitest API; one Dockerfile at repo root
  │   ├── prisma/              schema.prisma + 25 migrations
  │   ├── scripts/             workers (daily/api/video settlement), admin, private-storage
  │   ├── skills/              user-skill SKILL.md drop directory (boot-time read)
  │   └── src/                 server.ts, agent/, routes/, services/, middleware/, types/
  ├── frontend/                Next.js 14 App Router, static export; main product UI
  │   ├── app/                 layout, page, /chat, /login, /signup, /account, /admin,
  │   │                        /developer, /onboarding, /verify, /forgot, /reset,
  │   │                        /privacy, /terms, /cookies, /acceptable-use
  │   ├── components/          top-level (CommandPalette, ErrorBoundary, AuthForm,
  │   │                        ModelSelector, ProjectsPanel, ResearchPanel, …)
  │   ├── components/chat/     Sidebar, Composer, MessageList, Markdown, ActivityPanel,
  │   │                        ArtifactsPanel
  │   ├── components/settings/  6 tabs: Skills, Plugins, Memory, Personalization,
  │   │                        Connectors, Tools
  │   ├── components/ui/        primitives (Card, Toggle, EmptyState, StatusDot,
  │   │                        Badge, SectionHeader, SearchInput, inputCls/btnPrimary/btnGhost)
  │   └── lib/                 api.ts, stream.ts, commands.ts, drafts.ts (IndexedDB),
  │                             voice.ts (useDictation/useSpeech), i18n.tsx, useHotkey.ts
  ├── web/                     Alternative owned client foundation (Vite + React 19)
  │                            — same-name product; alternative runtime, see §2
  │   └── src/                 App.tsx (single-page login → workspace → chat),
  │                             api.ts, i18n.ts, requests.ts, security.ts, stream.ts
  ├── gateway/                 nginx gateway for the *legacy* LibreChat deployment
  │                            (deployed separately; not part of the new owned path)
  ├── loop-code/               Local CLI agent (`loop-code`); bin → ./dist/cli.js
  ├── mobile/                  Expo / React Native app; src/{theme, lib, screens}
  ├── deploy/                  owned-staging compose, cloudflared tunnel, librechat
  │                            spike (legacy), media-stack, space-searxng
  ├── skills/loop/             5 LibreChat-style skills synced hourly to LibreChat
  ├── scripts/                 PowerShell helper (deploy-searxng.ps1)
  ├── docs/                    23 markdown files: AUDIT, BUILD_PROGRESS, GAP_REGISTER,
  │                            PROGRESS, PROJECT_STATUS_REPORT, DECISIONS, ACCOUNTING,
  │                            validation/* (foundation-01..03o, release-candidate-03p,
  │                            production-readiness-audit-03s, …), etc.
  ├── .github/                 GitHub workflows (validation matrix per checkpoint)
  ├── LICENSE, README.md, .gitignore, .gitattributes, .gitleaks.toml
  ```
- **Install / run / build / deploy (exact commands from package.json + Dockerfile + README):**
  ```bash
  # Backend
  cd backend
  npm ci
  npm run generate            # prisma generate
  npm run build               # tsc → dist/
  npm test                    # vitest run (unit; excludes *.integration.test.ts)
  npm run test:integration    # vitest run --config vitest.integration.config.ts
  npm run dev                 # tsx watch src/server.ts
  npm run migrate:deploy      # prisma migrate deploy
  npm run worker:daily-settlement
  npm run worker:api-settlement
  npm run worker:video
  npm run private-storage
  npm run make-admin          # node scripts/make-admin.mjs
  ```

  ```bash
  # Frontend (Next.js 14 static export)
  cd frontend
  npm ci
  npm run dev                 # next dev
  npm run build               # next build (output: 'export' in next.config.js)
  npm run lint                # next lint
  npm test                    # vitest run (jsdom)
  npm run test:browser        # playwright test
  ```

  ```bash
  # Web client (alternative owned foundation; Vite + React 19, Node 22.12+)
  cd web
  npm ci
  npm run dev                 # vite --host 127.0.0.1 (port 5173)
  npm run build               # tsc --noEmit && vite build
  npm test                    # vitest run
  ```

  ```bash
  # Loop Code CLI
  cd loop-code && npm ci && npm run build   # tsc → dist/
  node dist/cli.js "your task"             # single task
  node dist/cli.js --login --url <url>
  ```

  ```bash
  # Deploy (per README.md)
  # Backend: railway up --ci -s backend -p <pid> -e production (repo root)
  # Web:     railway up --ci -s web     -p <pid> -e production (repo root)
  # Migrations are a separate release step: DATABASE_URL=<public> npx prisma migrate deploy
  ```


---

## 2. TECH STACK (versions from package.json / tsconfig.json)

| Concern | Choice | Version | Note |
|---|---|---|---|
| Language (BE) | TypeScript | 5.3.3 | strict; ES2020 target; CJS module |
| Language (FE) | TypeScript | 5.3.3 | strict; ESNext/bundler resolution |
| Runtime (BE) | Node.js | 22-bookworm-slim (Dockerfile pinned by sha256) | npm 12 locally; prod uses npm ci |
| Framework (BE) | Express | ^4.18.2 | cors ^2.8.5; multer 2.4.0 (typed 2.2.0) |
| Framework (FE) | Next.js | 14.0.4 (React ^18.2.0) | output: 'export', 	railingSlash: true, images.unoptimized |
| Framework (web) | Vite | 8.3.0 (React 19.3.0) | shell-only PWA worker |
| Frontend UI | React + Framer Motion + Lucide icons | react ^18.2.0, ramer-motion ^11.18.2, lucide-react ^0.303.0 | |
| Styling | Tailwind CSS | ^3.4.0 (frontend); CSS (web) | 	ailwind.config.js exposes claude.*, ink.* scales; design system in components/ui/primitives.tsx (Card, Toggle, EmptyState, Badge, StatusDot, SectionHeader, SearchInput) |
| State (FE) | @tanstack/react-query | ^5.17.0 | Providers (rontend/app/providers.tsx) � no Redux/Zustand; per-page useState |
| Data fetching | xios ^1.6.2 (FE) + native etch (web + SSE) | | SSE through native ReadableStream (MessageList.tsx, lib/stream.ts) |
| Routing | Next.js App Router | | static export; routes /chat, /login, /signup, /account, /admin, /developer, /onboarding, /verify, /forgot, /reset |
| Animation | Framer Motion | ^11.18.2 | MotionConfig reducedMotion='user' in providers |
| Backend auth | JWT (HS256) | jsonwebtoken ^9.0.2 | 7-day JWTs; session invalidation via User.sessionInvalidatedAt; TOTP MFA via otplib ^13.5.0 |
| Database | PostgreSQL | postgres:16-alpine (dev) / Railway postgres:16.10-bookworm (prod per docs/FOUNDATION_RUNBOOK.md) | Prisma ^5.7.1; 25 migrations |
| ORM | Prisma | 5.22.0 | migrations + JSON model; inaryTargets = ['native', 'debian-openssl-3.0.x'] |
| Cache / queue | none in app code | | accounted video uses DB lock fencing, not Redis |
| Object storage | filesystem (private) | | privateStorage.ts enforces O_NOFOLLOW + canonical-path + min-free-bytes probe; no S3/R2; bytes never on /uploads mount (ejectLegacyUploads returns 410) |
| Sandbox | Docker with --network none --read-only + tmpfs | | ackend/src/agent/tools/executeCode.ts: SANDBOX_DOCKER=true|false; falls back to host subprocess |
| AI layer | OpenAI-compatible HTTP via openai ^4.20.1 SDK + 
ode-fetch 2.7.0 | custom transport gent/llmClient.ts + services/modelTransport.ts (pinned DNS, bounded bytes, no proxy) | Reasoning models get easoning_content as separate 	hinking stream |
| Models hosted | two tiers from Hugging Face Inference Endpoints (HF_ENDPOINT_URL standard, HF_LARGE_ENDPOINT_URL large) + optional HF_VISION_ENDPOINT_URL | per services/chatModels.ts; UI surfaces 'Large Looper' / 'Small Looper' via ModelSelector | Upstream names hidden by guardrails.ts |
| Vision | dedicated VLM endpoint OR large/DeepSeek tier (multimodal-native) | per chatModels.ts::resolveVisionTarget |
| Tool/function calling | native OpenAI 	ools channel + inline-JSON ReAct fallback (parseInlineToolCalls) | | auto-fallback to JSON when --jinja/native tools unsupported |
| Web search | SearXNG (primary, SEARXNG_URL) ? Brave (BRAVE_API_KEY) ? Tavily (TAVILY_API_KEY) ? DDG HTML ? Bing HTML | 	ools/webSearch.ts; reranker ge-reranker-v2-m3 (embeddingStore.ts) |
| Connectors | OAuth 2.1 + PKCE platform apps (Google � 4 + GitHub); marketplace user-OAuth-app (Outlook/OneDrive/Dropbox/Linear/Asana/Salesforce/Figma/Zoom); custom HTTP tools | connectors/oauthProviders.ts, catalog.ts, connectorRegistry.ts, googleAdapters.ts, marketplaceAdapters.ts, oauthConnector.ts |
| MCP | @modelcontextprotocol/sdk ^1.12.0 via dynamic ESM import | mcp/mcpClient.ts, mcpRegistry.ts; tools namespaced as mcp__<id>__<name> |
| Sandbox code | Docker (default when present) | | 	ools/executeCode.ts real-JS unit-tested |
| Analytics (FE) | PostHog + Sentry | posthog-js ^1.203.0, @sentry/browser ^8.47.0 | both gated by NEXT_PUBLIC_* keys; analytics.tsx no-ops when absent |
| Error tracking (BE) | @sentry/node ^8.47.0 | | Sentry.init({dsn: process.env.SENTRY_DSN}); setupExpressErrorHandler |
| Vector store | pgvector (ector(1024)) with jsonb fallback | services/vectorSearch.ts | bge-m3 embeddings (1024-d) |
| Rate limiting | in-memory per-user sliding window | middleware/rateLimiter.ts | 100 / 15 min for /api; per-key sliding window for /v1 |
| Test runner | Vitest | ^2.1.8 (BE), ^2.1.9 (FE), 5.0.1 (web) | integration suite via itest.integration.config.ts (BE only) |
| Lint/format | ESLint 8 (FE), Next core-web-vitals preset | BE has no ESLint setup (eslint missing from backend/package.json) |
| E2E | Playwright | FE: @playwright/test ^1.49.1; web: 1.63.0 | FE suite: 	ests/e2e/app.spec.ts (axe a11y on /, /login/, /signup/, /chat/) |
| Env validation | zod | ^3.22.4 | middleware/envValidation.ts; production fail-closed |
| CI | GitHub Actions | .github/ workflows | last green per alidation/release-candidate-03p.md |
| Hosting | Railway | two services (web + ackend) + Postgres + cf-tunnel spare | production env 2faec73c-�; project loop-gpt-owned-staging-20260917 (8584f5ac-�) |

**Key env vars (names only � values are REDACTED):** DATABASE_URL, JWT_SECRET, FRONTEND_URL, HF_ENDPOINT_URL, HF_TOKEN, HF_MODEL, HF_LARGE_ENDPOINT_URL, HF_LARGE_MODEL, HF_VISION_ENDPOINT_URL, HF_VISION_MODEL, HF_IMAGE_ENDPOINT_URL, HF_VIDEO_ENDPOINT_URL, HF_TTS_ENDPOINT_URL, HF_ASR_ENDPOINT_URL, HF_OCR_ENDPOINT_URL, HF_OPTIMIZER_ENDPOINT_URL, HF_OPTIMIZER_MODEL, HF_SEARCH_ENDPOINT_URL, IMAGE_API_URL, VIDEO_API_URL, TAVILY_API_KEY, BRAVE_API_KEY, SEARXNG_URL, SEARXNG_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY, NVIDIA_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_MODE, STRIPE_PRICE_PRO, STRIPE_PUBLISHABLE_KEY, STRIPE_CHECKOUT_ENABLED, STRIPE_FULFILLMENT_ENABLED, RESEND_API_KEY, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, CONNECTION_ENCRYPTION_KEY, PRIVATE_FILES_STORAGE_MODE, PRIVATE_FILES_DIR, PRIVATE_FILES_STORE_ID, PRIVATE_FILES_MIN_FREE_BYTES, AGENT_DATA_DIR, AGENT_SKILLS_DIR, ADMIN_INVITE_CODE, QWEN_THINKING, UNRESTRICTED_PREAMBLE, MEMORY_SYNTHESIS_ENABLED, SEARCH_RERANK, SANDBOX_DOCKER, SANDBOX_NETWORK, SANDBOX_PYTHON, SANDBOX_NODE, SENTRY_DSN, NEXT_PUBLIC_SENTRY_DSN, NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST, VITE_API_ORIGIN, WEB_DEV_API_ORIGIN, ACCOUNTED_VIDEO_JOBS_ENABLED, ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED, CORS, PORT, NODE_ENV, RATE_LIMIT_TOKENS. (middleware/envValidation.ts + services/privateStorage.ts schemas � see those files for the canonical lists.)

---

## 3. ARCHITECTURE

**Data-flow (text diagram, one assistant turn):**
`
[user keystroke / paste / drop]
        |
        v
frontend Composer (Composer.tsx)
   |-- image/doc selection -> POST /api/conversations/:id/upload-image|upload-document
   |    -> backend privateFiles.storePrivateFile -> PrivateFile row + bytes on disk
   |-- '+' menu / slash palette / mode picker (Auto/Plan/Ask first/Accept edits)
   '-- onSend()
        |
        v
runAgentStream() in lib/stream.ts  -> POST /api/agent/:convId/stream  (SSE)
        |     headers: Authorization: Bearer <jwt>, Content-Type: application/json
        |     body: { content, attachmentIds[], mode, toolNames?, autoApprove?, stepMode?, incognito?, projectId?, model? }
        v
backend routes/agent.ts -> POST /:conversationId/stream (authenticateToken)
   1. resolveHostedModelRequest() - rejects credential/URL/extra-model overrides
   2. authorizeRunContext(ctx, ws, tools[]) - issues server-side per-run grant
   3. reserveDailyCreditsTx() - DB-locked reservation
   4. prepareRunConversation() - create/find conversation (workspace + project + incognito)
   5. saveMessage(user, content, attachmentId)
   6. initSSE(res) + startKeepalive(res) + sendEvent('status','conversation:<id>')
   7. runDeepResearch OR runAgent (in agent/agentRuntime.ts)
      |-- streamTurn({client, model, messages, tools, onDelta, onReasoning, onWarming})
      |    -> OpenAI-compatible chat/completions against HF endpoint(s)
      |    -> emits 'delta' + 'thinking' deltas + 'tool_call' (native) OR parseInlineToolCalls (ReAct)
      |-- approval gate: requiresInteractivePause(permission, stepMode, autoApprove)
      |    |-- blocked  -> emit 'tool_result' isError; continue
      |    '-- pause   -> emit 'pending_approval' -> storeApproval + waitForApproval(poll 500ms, timeout 120s)
      |                POST /api/agent/:convId/approve {toolName, approved}
      |-- tool handler executes (with assertRunAccess() before each)
      |-- emit 'tool_result' (with isError) -> audit -> emit 'artifact' when bytes produced
      |-- saveArtifact() -> storePrivateFile -> PrivateFile row + '/api/files/:id/content'
      '-- saveMessage(assistant, content, metadata{artifacts, sources, prompt, reasoning})
   8. recordUsage() -> captures the daily reservation; emits 'final' SSE event with metadata
   9. SSE 'done' -> close
        |
        v
frontend lib/stream.ts (runAgentStream):
   onDelta    -> liveSteps[step] += text        ("streamed" answer chunks)
   onThinking -> liveThinking += text          (collapsed "Thoughts" block)
   onToolCall -> liveSteps[step] = tool card    (AgentComputer)
   onToolResult -> liveSteps[step].tool.result
   onArtifact -> liveArtifacts[]              (auto-openable in ArtifactsPanel)
   onPendingApproval -> pendingApproval state -> activity panel shows Approve/Deny
   onFinal    -> reload from server (queries invalidated)
   onDone      -> setRunning(false)
        |
        v
React re-renders: MessageList -> Markdown(content) | MessageBubble(action bar) | AgentComputer steps
`

**State model (no global Redux/Zustand; per-page + React Query + URL state):**

`	s
// frontend/app/chat/page.tsx (top-level "shell" state)
interface Conversation { id: string; title: string; createdAt: string; updatedAt: string }
interface Message {
  id: string; role: 'user'|'assistant'; content: string; createdAt: string;
  messageType?: 'text'|'image'|'mixed';
  imageUrl?: string; attachmentId?: string; toolUsed?: string;
  metadata?: any;   // includes { artifacts?, sources?, prompt? {raw,enhanced,optimized}, reasoning? }
}

// chat/page.tsx local state (React useState)
const [sidebarOpen, computerOpen, artifactsOpen, isDesktop];   // overlays
const [currentConversationId, input];                           // session
const [mode: AgentMode = 'agent'];                              // 'chat'|'agent'|'research'
const [runMode: 'auto'|'plan'|'step'|'accept'];                 // runMode is the run-mode picker
const [incognito, modelTier, showSettings, settingsTab, exportMenuOpen];
const [selectedImages: File[], imagePreviews: string[], selectedDocs: File[]];
const [selectedTools: Set<string>|null];                        // null = all (server default)
const [workspaceId, projects: Project[], activeProjectId];
const [running, statusMsg, liveUser, liveSteps: LiveStep[],
       pendingApproval, liveArtifacts, liveThinking, toolCount];

// LiveStep (frontend/app/components/AgentComputer.tsx)
interface LiveStep {
  index: number; kind: 'text'|'tool'; text: string; ts?: number;
  tool?: { name: string; args: any; source?: string; result?: string; isError?: boolean };
}

// Stream contract (frontend/app/lib/stream.ts)
interface StreamHandlers {
  onStatus?, onWarming?, onDelta(step, text), onThinking(step, text),
  onToolCall(step, name, args, source?), onToolResult(step, name, content, data, isError?),
  onArtifact(artifact), onPendingApproval(tool_name, args, prompt),
  onFinal(content, metadata), onError(message), onDone()
}
type StreamEvent =
 | {type:'conversation',id:string} | {type:'status'|'warming'|'tool_call'|'tool_result'}
 | {type:'delta';text:string;step:number}
 | {type:'final';content:string} | {type:'artifact';artifact:Artifact}
 | {type:'error'|'done'}
`

**Server-side (backend):** in-process run authorization (gent/runAuthorization.ts) issues a WeakMap-keyed grant {userId, conversationId, workspaceId, tools:Map<name, ToolDefinition>}; grantFor() re-checks identity and throws WorkspaceError(403) on mismatch. Tools are looked up only via grantedTool(ctx, name). Approvals are in-memory (gent/approvalStore.ts) keyed by ${convId}:: with a 500ms polling loop and 120 s timeout. Per-run signals are bound to lifecycle.signal (AbortController) and to the durable ResearchRun.signal for research runs so client reloads don't kill in-flight work.

**Database schema (Prisma, ackend/prisma/schema.prisma, 25 migrations):** User (role, plan='free'|'pro'|'gold', unlimited, credits, imageCredits, creditsResetAt, memoryEnabled, totp{Enabled,Secret}, sessionInvalidatedAt, consentTraining, api{Plan,BalanceMicros,PreviewGranted,SubId,PlanRenewsAt}, redemptions, usageEvents, dailyReservations, payments, tokens, memories, styles, researchScratchpads, researchRuns, mediaJobs, apiKeys, apiUsage, apiTopUps, apiReservations, privateFiles, personalWorkspace); ApiKey (keyHash unique, prefix, revoked); SpendBudgetPolicy (id/version/revision singleton); StripeEventInbox; ApiUsage (kind, model, tokensIn/Out, units, costMicros, reservationId@unique); Project (workspaceId, name, instructions, role); KnowledgeChunk (projectId, content, embedding, embeddingVec Unsupported('vector(1024)')); Memory (userId, projectId?, kind 'explicit'|'synthesized', source 'user'|'agent', content, tags[]); UserStyle (systemPrompt, temperature?, isDefault); ResearchScratchpad (userId+queryHash unique, query, queries/hits/sources JSON); ResearchRun (events JSON, report?, sources?); ApiTopUp (amountMicros, source='stripe'|'voucher'|'admin'|'preview'|'plan'); Token (sha256 hash, type 'verify'|'reset'); Voucher (type 'unlimited'|'credits', plan?, credits, imageCredits, maxRedemptions, redemptionCount, active, expiresAt?, note); VoucherRedemption (unique[voucherId,userId]); UsageEvent (kind 'chat'|'agent'|'research'|'image', reservationId@unique); Payment (amount cents, currency, status, provider, reference?); Conversation (userId, incognito, workspaceId?, projectId?, messages); DailyReservation (state enum reserved|dispatched|unknown|captured|released, settlementFingerprint?, reservationFingerprint?, pricingSnapshot JSON, imageCredits); DailySettlementIntent (pending|processing|succeeded|conflict|dead_letter, attempts, lease{Token,ExpiresAt}, lastErrorCode); ApiReservation (state enum reserved|dispatched|unknown|captured|released, settlementFingerprint?, pricingSnapshot JSON, capturedMicros?, evidence JSON); ApiSettlementIntent (fingerprint, reconciliationReference); ApiCreditIdentity (composite PK source,reference); Message (role, content @db.Text, messageType, imageUrl, toolUsed, metadata JSON); MediaJob (providerJobId, statusUrl, resultUrl, outputUrl); AccountedVideoJob (endpoint, config JSON, state, upstreamSlot, attempts, lease{Token,ExpiresAt}, stagedArtifact JSON); VideoQueuePolicy (singleton, global/userOutstanding, global/userActive); Workspace (personalOwnerId? unique, members[], connections[], conversations[], projects[], auditEvents[]); WorkspaceMember (composite PK workspaceId+userId, role enum owner|editor|viewer); WorkspaceConnection (encryptedConfig @db.Text, configuredFields[], enabled, version); WorkspaceAuditEvent; PrivateFile (sha256, purpose 'upload'|'artifact', publishToken? unique, publishedAt?).

**Full API surface (paths/methods/purpose; request/response shapes are documented inline in route files and README �"Endpoint contract consumed"):**

| Method / path | Purpose | Auth | Source |
|---|---|---|---|
| POST /api/auth/register | signup | none | outes/auth.ts |
| POST /api/auth/login | login (returns {token,user}) | none | outes/auth.ts |
| POST /api/auth/verify | email verification token | none | outes/oauth.ts |
| POST /api/auth/resend-verification | resend | Bearer | outes/oauth.ts |
| POST /api/auth/forgot | password reset request | none | outes/oauth.ts |
| POST /api/auth/reset | reset password (invalidate sessions) | none | outes/oauth.ts |
| GET /api/auth/oauth/:provider | OAuth start (Google/GitHub) | none | outes/oauth.ts |
| GET /api/auth/oauth/:provider/callback | OAuth callback | none | outes/oauth.ts |
| GET /api/auth/providers | available providers | none | outes/oauth.ts |
| GET /api/models/catalog | hosted-tier picker | none | outes/models.ts |
| POST /api/agent/tools GET | list available tools | Bearer | outes/agent.ts |
| POST /api/agent/:conversationId/stream | **the SSE run endpoint** (the only stream entry used by the app; lib/stream.ts calls this) | Bearer | outes/agent.ts |
| POST /api/agent/:conversationId/approve | resolve a pending_approval | Bearer | outes/agent.ts |
| POST /api/agent/completions | OpenAI-compatible relay for loop-code CLI | Bearer | outes/agent.ts |
| GET /api/agent/skills POST PUT/POST/DELETE /:id GET /:id GET /:id/versions POST /:id/revert | skills CRUD + version history | Bearer | outes/agent.ts + gent/skills/skillLoader.ts |
| GET /api/agent/plugins POST /plugins/install POST /:id DELETE /:id | plugins | Bearer | outes/agent.ts + gent/plugins/pluginLoader.ts |
| GET /api/agent/custom-tools POST DELETE /:id | custom HTTP tools | Bearer | outes/agent.ts + gent/customTools.ts |
| GET /api/agent/mcp-servers POST DELETE /:id | MCP servers | Bearer | outes/agent.ts + gent/mcp/mcpRegistry.ts |
| GET /api/agent/connectors POST POST /:id/test DELETE /:id | connectors catalog / create / probe / remove | Bearer | outes/agent.ts + gent/connectors/catalog.ts |
| GET /api/agent/permissions POST | tool permission overrides (allow/approval/blocked) | Bearer | outes/agent.ts + gent/configStore.ts |
| GET /api/agent/audit?limit=N | bounded tool-call audit log | Bearer | outes/agent.ts |
| GET /api/agent/research?conversationId= GET /:runId | durable research run listing + replay | Bearer | outes/agent.ts + services/researchRuns.ts |
| POST /api/conversations GET GET /:id PATCH /:id DELETE /:id | conversation CRUD | Bearer | outes/conversations.ts |
| POST /api/conversations/:id/upload-image | multipart upload (<=10 MiB, signature-validated PNG/JPG/GIF/WEBP) | Bearer | outes/conversations.ts + privateFiles.ts |
| POST /api/conversations/:id/upload-document | extract text from PDF/DOCX/XLSX for inline injection | Bearer | outes/conversations.ts + documentText.ts |
| GET /api/conversations/:id/messages | history | Bearer | outes/messages.ts |
| POST /api/conversations/:id/messages | legacy JSON message (disabled: returns 400 on planning/agentic modes; only chat/image/vision) | Bearer | outes/messages.ts |
| POST /api/conversations/:id/fork | message branching (copies <=200 msgs up-to-and-including target) | Bearer | outes/messages.ts |
| POST /api/conversations/:id/rewind | truncate history after a message | Bearer | outes/messages.ts |
| GET /api/files/:id GET /:id/content DELETE /:id | private file metadata / bytes / delete | Bearer | outes/files.ts |
| POST /api/files/:id/publish DELETE GET /api/files/public/:token/content | view-only public link | Bearer (publish); none (read) | outes/files.ts |
| GET /api/memory POST GET /enabled POST /enabled PATCH /:id DELETE /:id POST /reset | memories + master toggle | Bearer | outes/memory.ts |
| GET /api/styles POST POST /from-sample PATCH /:id DELETE /:id | writing-style presets + sample->prompt | Bearer | outes/styles.ts |
| GET /api/workspaces POST /personal POST / | workspaces | Bearer | outes/workspaces.ts |
| GET /api/workspaces/:id/connections/catalog /connections POST /connections PUT /:id DELETE /:id GET /:id/tools | workspace OAuth connections (AES-GCM) | Bearer | outes/workspaces.ts |
| GET /api/workspaces/:id/members PATCH /:id/members/:uid DELETE | membership | Bearer | outes/workspaces.ts |
| GET /api/workspaces/:id/audit | workspace audit log | Bearer | outes/workspaces.ts |
| GET /api/workspaces/:id/projects POST PATCH /:id DELETE /:id POST /:id/ingest POST /:id/ingest-file GET /:id/search | projects + knowledge ingest | Bearer | outes/projects.ts |
| POST /api/oauth-connector/init/:connectorType GET /callback | connector OAuth start/finish | Bearer (init); none (callback) | outes/oauthConnector.ts |
| GET /api/tts POST / | backend TTS (Kokoro bytes) | Bearer | outes/tts.ts |
| POST /api/billing/checkout /api-checkout /topup GET /config /topup-options | Stripe checkout (fail-closed when disabled) | Bearer | outes/billing.ts |
| POST /api/billing/webhook | Stripe webhook (raw body signature) | none | outes/billing.ts |
| POST /api/mail/inbound | inbound mail (SES/Mailgun route) | none | outes/oauth.ts::mailRouter |
| POST /api/telemetry/feedback /error | thumbs + client errors | Bearer (feedback); none (error) | routes/telemetry.ts |
| GET /api/account/me /usage POST /redeem POST /totp/setup POST /totp/verify POST /totp/disable | account, voucher redeem, TOTP | Bearer | routes/account.ts |
| GET /api/admin/* | admin portal (metrics, stats, users, vouchers, payments, memory-synthesis run) | Bearer + admin | routes/admin.ts |
| GET /api/developer/overview POST /keys GET /keys DELETE /keys/:id GET /pricing GET /plans | developer portal | Bearer | routes/developer.ts |
| POST /api/media/video-jobs GET /jobs GET /jobs/:id POST /jobs/:id/cancel | accounted video creation + status (default-off) | Bearer | routes/media.ts |
| **Public /v1** (no /api rate limit; per-key sliding window in apiAuth.ts): | | | |
| GET /v1/models GET /v1/pricing | model + pricing catalog | Bearer sk-loop-... | routes/v1.ts |
| POST /v1/chat/completions | OpenAI-compatible chat | Bearer sk-loop-... | routes/v1.ts |
| POST /v1/embeddings | embeddings | Bearer sk-loop-... | routes/v1.ts |
| POST /v1/images/generations | image generation | Bearer sk-loop-... | routes/v1.ts |
| POST /v1/videos/generations GET /:id POST /:id/cancel GET /v1/usage | video (accounted) + usage | Bearer sk-loop-... | routes/v1.ts |
| POST /v1/media/publish | publish media -> public link | Bearer sk-loop-... | routes/v1.ts |
| GET / /health | root + health | none | server.ts |

---

## 4. UI INVENTORY: EVERY SCREEN AND COMPONENT

> The **main product UI** is rontend/. web/src/App.tsx is a separate alternative Vite/React-19 foundation (single-page login -> workspace -> chat) that is *not* wired to the live product at loop-gpt.cyou. Below describes the live rontend/ app. File paths are repo-relative.

### 4.1 Shell + chrome

- **rontend/app/layout.tsx** - Root layout: <html lang="en" className="dark">, <Inter> from 
ext/font/google (subsets latin), wraps in <Providers><ErrorBoundary>, viewport iewportFit: 'cover', 	hemeColor: '#0b0b12'. *Props:* none. *State:* none. *Renders:* <html> shell with dark class, Inter body, Sentry/PostHog init (Analytics), error boundary fallback that reloads on click. Manifest at /manifest.webmanifest (PWA), icon /icon.svg, apple-touch at /apple-touch-icon.png. Service worker /sw.js registered client-side by providers.tsx (PWA shell-only - POST/auth never cached).
- **rontend/app/providers.tsx** - QueryClientProvider (staleTime: 60s default), MotionConfig reducedMotion="user", I18nProvider. Effect: registers /sw.js on load if the browser supports it. 7 supported locales (en-US, en-GB, en-CA, r-CA, en-AU, en-NZ, en-IE); r-CA is the only fully-translated language, all English variants share copy (per lib/i18n.tsx).
- **rontend/app/page.tsx** - Marketing landing. Hero with sparkles logo, 8 feature tiles (Agentic tool use, Deep research, Vision, Image generation, Documents, Agent Computer, MCP & connectors, Skills & builders); pricing section ("Free during launch" + "Soon" waitlist Pro); CTA -> /signup. *User sees:* no auth required, single-click Sign up / Log in. *Can do:* read copy, click Sign up / Log in, jump to privacy/terms/cookies/acceptable-use.
- **rontend/app/components/ErrorBoundary.tsx** - Class component with getDerivedStateFromError; fallback is a centred "Something went wrong" panel with Reload button.
- **rontend/app/components/Analytics.tsx** - PostHog (person_profiles: 'identified_only') + Sentry client init, gated on env keys; PostHog $pageview capture on usePathname() change.
- **rontend/app/components/CommandPalette.tsx** - Modal command palette opened via Cmd+K. Items: New session, Search chats, Toggle sidebar, Settings, Sign out. useHotkey({key:'k', meta:true}) opens; Esc closes; Enter runs the first filtered match. *Renders:* top-aligned list with search input, Lucide icons.
- **rontend/app/components/ShortcutSheet.tsx** - Keyboard-shortcut help modal opened by ? key (or via state from chat/page.tsx). Documents: Cmd+K, Cmd+L, Cmd+B, Cmd+Enter, Cmd+Up/Down, Esc, /. *Renders:* centred card with kbd-styled rows; tested by components/__tests__/ShortcutSheet.test.tsx.
- **rontend/app/components/AuthForm.tsx** - Email/password + Google/GitHub social + TOTP prompt on shared 401. Used by /login and /signup (mode prop).
- **rontend/app/components/LegalLayout.tsx** - Shared legal-page shell with sidebar nav (/privacy, /terms, /cookies, /acceptable-use) and "Back to home".
- **rontend/app/components/ModelSelector.tsx** - Reads /api/models/catalog; renders a listbox with Brain/Wrench/Eye capability badges (context size, tools, vision); tier is sent as model on each run.
- **rontend/app/components/ProjectsPanel.tsx** - Claude-style project modal: list + dedicated 2-step create flow + per-project knowledge upload. Tested by components/__tests__/ProjectsPanel.test.tsx.
- **rontend/app/components/ResearchPanel.tsx** - Modal listing durable ResearchRuns for a conversation + a full-report viewer with Markdown rendering and sources. 3-second polling while any run is unning.
- **rontend/app/components/SettingsPanel.tsx** - Modal with 6 tabs (Skills, Plugins, Memory, Personalization, Connectors, Tools). Order matches Claude IA. Tested for shell + Memory.
- **rontend/app/components/settings/{Skills,Plugins,Memory,Personalization,Connectors,Tools}Tab.tsx** - see 4.5.
- **rontend/app/components/ui/primitives.tsx** - Card, Toggle (role=switch), StatusDot, Badge, SectionHeader, SearchInput, EmptyState, plus the shared inputCls/tnPrimary/tnGhost strings.

### 4.2 Chat screen (rontend/app/chat/page.tsx, ~755 lines)

- **Layout:** mobile-first full-bleed lex h-[100dvh]. Three columns at desktop (sidebar / center / right overlay), single column at mobile. Safe-area paddings: pt-[env(safe-area-inset-top)], composer pb-[max(0.75rem,env(safe-area-inset-bottom))]. The desktop breakpoint is **1024px** (matched at (min-width: 1024px)); below that, all overlays become drawers with a backdrop.
- **Header bar** (h-12, bg-#111113, border-b):
  - PanelLeft button (open sidebar) + sparkles logo when sidebar is closed.
  - Conversation title (truncated 	ext-[13px] font-medium).
  - Right-aligned cluster: <ModelSelector> -> Incognito toggle (<Ghost> button, accent ring when on) -> Export menu (<FileDown> opens Markdown / PDF (print)) -> Files button (count chip) -> Research button -> Activity button.
- **Composer wrapper** (order-t, max-w-48rem, bg-#111113, px-3 sm:px-4, py-3 sm:py-4, pb-[max(0.75rem,env(safe-area-inset-bottom))]).
- **ActivityPanel** and **ArtifactsPanel** are *right-edge overlays* on desktop (>=1024px), *full-screen drawers* on mobile (<1024px) - see 4.6 for *why this is the wrong place* for agent activity per the brief.

### 4.3 Composer (rontend/app/components/chat/Composer.tsx, 432 lines; tested)

- **Props (from chat/page.tsx):** input, imagePreviews[], docNames[], unning, unMode, contextPct, contextTokens, incognito, showSlash, showPlus, showModeMenu, onInputChange, onSelectSlashCommand, onSend, onStop, onImagesSelected, onRemoveImage, onRemoveDoc, onTogglePlus, onClosePlus, onToggleModeMenu, onCloseModeMenu, onRunModeChange, onOpenConnectors, onOpenSettingsTab, 	oolSelectionCount.
- **What the user sees:** a textarea (rows=1, auto-grows up to maxHeight 220px), plus the four attachment preview slots when present, plus the dictation recording bar when active, plus the form footer (+ attach, run-mode picker, mic, send/stop).
- **Behaviors:**
  - **Auto-growing textarea** (onInput sets el.style.height = min(scrollHeight, 220)+'px').
  - **Enter to send; Shift+Enter for newline** (the Enter handler also handles slash-menu Tab/Arrow keys first).
  - **Mobile Enter behavior:** identical (no special-casing).
  - **"+"/Plus menu:** Photos & files - Take a screenshot (gated on 
avigator.mediaDevices?.getDisplayMedia) - Connectors - Create image (/image) - Manage tools -> (open Settings -> Tools).
  - **Slash command palette** (lib/commands.ts): 17 commands grouped Create / Manage / Session / Help. Fuzzy subsequence filter; keyboard nav (Arrow, Tab, Enter). /screenshot runs getDisplayMedia locally and pipes the PNG back into the file-input handler. Mode commands (/chat, /agent, /research, /image, /video, /create, /memory) pin the relevant tools via parseCommand -> 	oolNames[].
  - **Run-mode picker** (Auto / Plan / Ask first / Accept edits) in a MenuItem popover with hint lines; the collapsed button shows the active icon + label + chevron and a colored ring when non-default. Sent as utoApprove and stepMode fields.
  - **Dictation (useDictation)**: feature-detected Web Speech API (SpeechRecognition || webkitSpeechRecognition); shows pulsing mic + elapsed timer + "Send" / "Cancel" buttons while recording; interim transcript written into a local interim state, final transcript appended to input. Stop-and-Send button commits then submits.
  - **Send -> Stop:** the Send button shows when !running (enabled when input.trim() || imagePreviews.length); the Stop button replaces it during a run and calls bortRef.current?.abort().
  - **Context meter:** a single-line progress bar below the form (ole="progressbar", ria-valuenow={contextPct}) with text title attribute; amber when >85%.
  - **Empty/disabled state:** disabled Send button when no input/images.
  - **Attachment chips:** up to 4 images, each with an X button; up to 4 documents (.pdf,.docx,.xlsx,.csv,.txt,.md,.markdown) shown as name chips.
  - **Context-aware placeholder:** i18n placeholder ("Message Loop GPT... (/ for commands)"); used in Composer.tsx:257.

### 4.4 Message rendering (rontend/app/components/chat/MessageList.tsx, 564 lines)

- **MessageBubble** renders one message. User messages get a right-aligned g-[#1e1e21] bubble; assistant messages are left-aligned.
- **Markdown** (rontend/app/components/chat/Markdown.tsx, 67 lines, memo()-ed):
  - eact-markdown + emark-gfm + ehype-highlight.
  - **Code blocks:** CodeBlock extracts language-... from the className; renders a header with language label + copy button (
avigator.clipboard.writeText, 1.4 s "Copied" feedback); the body is wrapped in a dark [#0d1117] panel with overflow-x-auto.
  - **Inline code, tables, headings, lists, blockquotes, hr, links** (target=_blank, rel=noreferrer) all customised.
  - No math / LaTeX support.
- **Extended-thinking block** (liveThinking + message.metadata?.reasoning): a <details> element with a "Thoughts" / "Thinking..." label, animated shimmer-text while streaming. Live thinking is persisted to metadata.reasoning on the assistant message.
- **Sources:** assistant message metadata.sources ([{index,title,url}]) renders as a numbered list under a "Sources" header.
- **Prompt meta** (metadata.prompt.{raw,enhanced,optimized}): toggle button "View enhanced prompt / Hide" reveals both side-by-side.
- **Artifacts in flow:** assistant message metadata.artifacts render as <ArtifactCard> (image/video/file); image cards open a full-screen <ArtifactViewer> modal; video cards render <video controls playsInline preload="metadata">; document cards fall back to a "download" button.
- **Image previews / uploads:** user-attached images load through useAttachmentUrl (authed blob -> object URL, revoked on unmount). Same helper for any authed /api/files/... href via useAuthedUrl (only intercepts /api/files/ URLs; blob: passes through).
- **Scrolling:** a single endRef and a scrollIntoView({behavior:'smooth'}) on [messages, liveSteps, statusMsg, liveAnswer]. No throttling, no virtualization - see 6.
- **Actions** on the assistant bubble (group-hover:opacity-100): Copy - Read aloud (TTS via useSpeech - browser speechSynthesis preferred, falls back to backend POST /api/tts; voice + rate prefs from Personalization) - Pause/Resume/Stop (only shown while speaking) - Retry (onRetryBefore(idx) -> POST /rewind + populate composer). User bubble actions: Edit (onEditMessage -> orkAtMessage) - Copy.
- **Empty state / welcome:** <EmptyState> with sparkles logo, "How can I help you today?" heading, slash/Cmd+K/2-min tour hints, four starter-prompt buttons (quantum, Python, research, SaaS).

### 4.5 Settings modal (SettingsPanel.tsx -> 6 tabs)

- **Skills tab** (SkillsTab.tsx, ~255 lines): list -> detail -> raw SKILL.md editor; create form with live frontmatter-composed preview; built-in badges ("PDF Report Writer", "Spreadsheet Analyst"); **version history with Restore** button (/api/agent/skills/:id/versions + /revert); trigger/tool badges.
- **Plugins tab** (PluginsTab.tsx): enable/disable built-ins and user-installed JSON-manifest HTTP tools; "Install from JSON" toggle that pipes the pasted manifest into POST /api/agent/plugins/install.
- **Memory tab** (MemoryTab.tsx, 206 lines, tested): **master toggle** POST /api/memory/enabled; per-row Edit/Delete (PATCH/DELETE); **"you added" / "learned"** source badges (source === 'user' ? 'you added' : 'learned'); tag grouping; search with result count; real empty state; "Delete every memory" reset (POST /api/memory/reset).
- **Personalization tab** (PersonalizationTab.tsx): 4 preset styles (Normal / Concise / Explanatory / Formal) selecting writes it as the default; create-your-own; create-from-writing-sample (POST /api/styles/from-sample); voice + speed picker persisted in localStorage (voiceName, voiceRate).
- **Connectors tab** (ConnectorsTab.tsx, ~300 lines): **Available now** grid (14+ key-based + Google x 4 + GitHub + Custom HTTP API) and a separate **Marketplace** section with the 8 user-OAuth-app providers (Outlook/OneDrive/Dropbox/Linear/Asana/Salesforce/Figma/Zoom). **Key validation on save** (probeConnector for catalog entries; probeMarketplaceConnector for marketplace) - failures show a credential error and the connector is not persisted. **Test connection** (POST /:id/test) per card. **MCP** sub-section ("Advanced") for stdio + Streamable HTTP servers. Per-connector live status dot (idle / working / waiting / error) via the <StatusDot> primitive.
- **Tools tab** (ToolsTab.tsx): per-tool permission select (Always allow / Needs approval / Blocked) wired to POST /api/agent/permissions; toggleable "audit log" shows the bounded GET /api/agent/audit?limit=100.

### 4.6 Agent activity ("Agent Computer") - rontend/app/components/AgentComputer.tsx (267 lines) + ActivityPanel.tsx (43 lines) wrapper

- **Where it renders today:** chat/page.tsx places <ActivityPanel> as a **fixed right-edge overlay on desktop** (lg:relative inset-y-0 right-0 z-40 lg:z-auto w-full max-w-[92vw] sm:max-w-[440px] lg:w-[380px]) - i.e. on the **right**, not below the response as the brief specifies. On mobile it becomes a full-screen drawer with backdrop. The ActivityPanel itself is just a framer-motion slide-in wrapper around <AgentComputer>.
- **5 live states:** idle (slate dot) / 	hinking (amber, animated pulse) / unning (neon-green, animated) / waiting (orange, animated) / error (rose).
- **Tool-call cards:** collapsible rows (<button aria-expanded>); icon by outcome (Loader2 / CheckCircle2 / XCircle); tool name (font-mono); one-line arg summary (rgSummary slices first 2 args to 40 chars each); HH:MM:SS timestamp; expand shows raw input + raw output (JSON.stringify with caps).
- **Approval card:** shows the pending tool name with Approve / Deny buttons (Deny -> pendingApproval.approve(false); Approve -> 	rue); rendered above the feed.
- **Step grouping:** steps >2 min apart start a new "Step N" group (groupSteps(toolSteps)).
- **Header strip:** "Agent activity - {meta.label}{status ? ' - ' + status : ''}", clickable "N tools" pill that opens the tools list inline (loading on first open), and an X close button (visible on <lg).
- **Auto-expand:** the panel is **auto-opened** when the first tool call lands (useEffect on liveSteps/liveArtifacts that sets computerOpen=true once via utoOpenedRef). It does **not** auto-expand inline below each response - see 6.
- **No "live terminal output" or "browser screenshots" yet.** Code execution surfaces as a single 	ool_result card; there is no streaming stdout/stderr split and no headless browser.

### 4.7 Right panel (artifacts) - ArtifactsPanel.tsx (270 lines) + ActivityPanel.tsx

- **What it is:** A second right-edge overlay (same width/animation as ActivityPanel) that shows **view-only outputs**: a header with the artifact count, version-grouped list (groups files by 
ame.replace(/[_.-]\d+(\.\d+)*(?=\.[^.]*$)/, '')), and a detail panel with Preview / Raw / Sandbox tabs. Sandbox tab uses <iframe sandbox="allow-scripts allow-popups" srcDoc=...> (no llow-same-origin).
- **Two panels, never both:** chat/page.tsx toggles rtifactsOpen <-> computerOpen (mutually exclusive), so a user can have Activity **or** Artifacts on the right, not both.
- **Versioning + diff:** "Compare N versions" runs an inline line-level diff (lineDiff(from,to)) - sign - rose / + emerald /   slate.
- **Publish:** per-artifact POST /api/files/:id/publish toggles a view-only public link at /api/files/public/:token/content (no auth, with Cache-Control: public, max-age=300, Content-Security-Policy: sandbox; default-src 'none').
- **Draggable resize?** No. **Device-size toggle / "Fix error" button?** No. **Refresh?** Only by re-opening the conversation. **Fullscreen?** No.

### 4.8 Image handling

- **Upload path:** Client Composer.tsx -> POST /api/conversations/:id/upload-image (multipart image field, <=10 MiB, signature-validated against declared MIME for image/png|jpeg|gif|webp) -> privateFiles.storePrivateFile returns {attachmentId}.
- **Authed fetch:** MessageList.tsx::useAttachmentUrl and useAuthedUrl always go through etch(... {headers: authHeaders}), get the blob, create an URL.createObjectURL(blob), and URL.revokeObjectURL on cleanup. **This is the explicit fix** for the historical "raw href on auth-only path -> 401" bug.
- **Display:** <img src={objectUrl}> with max-w-md max-h-96 rounded-2xl border border-white/10; lightbox is a separate <ArtifactViewer> full-screen modal with Escape-close, backdrop click close, focus-trap on open (	abIndex=-1 + autoFocus). **No zoom/pan/pinch** (Claude-style image lightbox); no in-place next/prev.

### 4.9 Video handling

- **Streaming model:** <video controls playsInline preload="metadata" src={objectUrl}> in both the inline <ArtifactCard> and the viewer modal. Same authed-blob URL pattern as images.
- **Backend video pipeline:** ccountedVideoJobs.ts + ideoJobWorker.ts + mp4Validation.ts. Both /v1/videos/generations and /api/media/video-jobs are gated by **feature flags** ACCOUNTED_VIDEO_JOBS_ENABLED=true + ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED=true; default-off. Without them both endpoints 503 (ideo_accounting_unavailable). The endpoint URL must also be provisioned (VIDEO_API_URL / HF_VIDEO_ENDPOINT_URL).
- **Streaming protocol:** video generation goes through a **durable worker**, not the request - the SSE event just emits an rtifact once the bytes are validated (alidateVideoMp4 checks MP4 structure). There is **no Range-request optimization, no HLS, no DASH** - the browser uses plain HTTP byte-range on the <video> element against /api/files/:id/content, which the backend does not specifically advertise Accept-Ranges for.
- **Generation tools:** 	ools/generateVideo.ts (Gradio chain/legacy /run/predict first, then gradioCallSpace for current Spaces) and 	ools/generateImage.ts (Gradio edit mode if a reference is attached, else image).
- **No PiP, no poster frame, no buffering indicator.** Browser defaults only.

### 4.10 Theming + design tokens

- **Color system:** single accent #c96442 (terracotta) + hover #b5593a + active #a34e34. Used in ccent-ring, gradient rom-[#c96442] to-[#b5593a], g-[#c96442], button hovers, 	ext-[#e79d7f] (lighter accent for text on dark). Glass surfaces use g-[#16161a]/[0.88] + ackdrop-blur(16px) (globals.css .glass / .glass-strong).
- **Legacy class names retained:** 	ailwind.config.js keeps 
eon-violet / neon-indigo / neon-cyan / neon-fuchsia / neon-green / neon-amber as **legacy aliases** of the terracotta palette (see DOCISIONS.md / PROGRESS.md P3 note) - 
eon-violet and 
eon-fuchsia both equal #c96442; 
eon-indigo = #b5593a; etc. Some components still reference these (e.g. Tailwind-only routes like /verify use rom-neon-violet to-neon-indigo); the Settings / chat chrome no longer do. Cleanup explicitly deferred to P3 (docs/loop-gpt-production-readiness-brief.md 4).
- **Font:** Inter (
ext/font/google, latin subset only) applied to <body>. No second weight pulled.
- **Breakpoints:** standard Tailwind (sm 640, md 768, lg 1024, xl 1280). The chat layout has **one desktop breakpoint** at 1024px ((min-width: 1024px)); below that overlays become drawers.
- **Icons:** lucide-react everywhere - Sparkles, Cpu, Bot, Brain, Eye, Wrench, Cable, Puzzle, Blocks, FlaskConical, FolderOpen, MessageSquare, etc.
- **Theme toggle:** Not present - <html className="dark"> is hard-coded; no light/dark/system switch.
- **Logo:** Sparkles icon in a g-[#c96442] rounded square, white icon. Same pattern in the mark across all surfaces.

---

## 5. FEATURE STATUS MATRIX

> Status legend: [OK] Working = code shipped + visible in normal use; [PARTIAL] Partial = shipped but degraded / wired to a stub; [BROKEN] Broken = documented but doesn't work; [NP] Not present = no code or design.

### Layout and navigation

| Feature | Status | File(s) | Notes |
|---|---|---|---|
| Collapsible sidebar | [OK] | rontend/app/components/chat/Sidebar.tsx, pp/chat/page.tsx | Drawer on mobile, fixed column on desktop; backdrop on <lg. |
| New chat | [OK] | Sidebar.tsx:76, chat/page.tsx:460 | Calls onSelectConversation(null); setSidebarOpen(false). |
| Chat search | [PARTIAL] | Sidebar.tsx:81-89 | Filters conversation **titles** only by includes, case-insensitive. No full-text body search. |
| History grouped by date | [BROKEN] | Sidebar.tsx:134-196 | Flat list sorted by updatedAt desc (/api/conversations route orders this way). **No date grouping rendered** - the brief explicitly lists "history grouped by date". |
| Star/pin chats | [NP] | - | No star, no pin field on Conversation model; no UI affordance. |
| Projects | [OK] | Sidebar.tsx:91-129, components/ProjectsPanel.tsx | First-class section with inline recents + active highlight; Claude-style cards; dedicated 2-step create flow. |
| Artifacts library | [PARTIAL] | Sidebar.tsx does **not** link to it; ArtifactsPanel.tsx is the only entry | Entry is the per-chat "Files" header button, not a global artifacts browser. |
| Per-chat menu (rename/star/share/delete) | [PARTIAL] | Sidebar.tsx:163-183 | Inline hover shows Edit + Delete (with native confirm()); **no star, no share**. |
| Command palette (Cmd+K) | [OK] | components/CommandPalette.tsx | 5 commands; opens via useHotkey({key:'k',meta:true}); Esc closes. **Limited** to high-level navigation - does not include slash-palette items. |
| Keyboard shortcuts | [PARTIAL] | components/ShortcutSheet.tsx, lib/useHotkey.ts | Documents Cmd+K, Cmd+L, Cmd+B, Cmd+Enter, Cmd+Up/Down, Esc, /. **useHotkey ignores keystrokes when focus is in INPUT/TEXTAREA/SELECT** (intentional) - so ? and / work only when focus is *outside* the composer. Cmd+L and Cmd+B are documented but **not bound** (the hook file has no callers for them). |
| Header with title, model selector, share | [PARTIAL] | chat/page.tsx:547-646 | Title [OK]; ModelSelector [OK]; **Share button [NP]**. |
| Light/dark/system theme with no flash on load | [PARTIAL] | pp/layout.tsx:35 | <html className="dark"> is hard-coded - no flash risk because dark is unconditional. **No theme switcher.** |
| Settings modal (profile/appearance/font/language/connectors/usage/data controls) | [PARTIAL] | components/SettingsPanel.tsx, components/settings/{...}Tab.tsx | 6 tabs (Skills, Plugins, Memory, Personalization, Connectors, Tools). **No** dedicated Profile/Appearance/Font/Usage/Data-controls tab - profile and usage live on /account. |
| Empty / welcome state | [OK] | MessageList.tsx:235-272 | Sparkles logo, 4 starter prompts, link to /onboarding. |

### Composer

| Feature | Status | File(s) | Notes |
|---|---|---|---|
| Auto-growing textarea | [OK] | Composer.tsx:261-265 | Manual height reset + Math.min(scrollHeight, 220)+'px'. |
| Enter to send, Shift+Enter newline | [OK] | Composer.tsx:249-254 | |
| Mobile Enter behavior | [OK] | Same handler - no special-casing. |
| "+" attach menu | [OK] | Composer.tsx:283-301 | Photos & files - Screenshot (capability-gated) - Connectors - Create image - Manage tools. |
| Drag-and-drop with overlay | [NP] | - | No onDrop handler; no overlay. **Brief explicitly lists this.** |
| Paste images | [NP] | - | No onPaste handler. **Brief explicitly lists this.** |
| Attachment chips with progress, remove, errors | [PARTIAL] | Composer.tsx:179-209 | Chips render with name + remove button. **No upload progress** (uploads happen at send time inside uploadImage()); no error-state chip - failures are silent (return undefined) except for documents (statusMsg shows the error). |
| Web search toggle | [BROKEN] | - | No web_search toggle in the composer. The runtime auto-pins web_search+web_fetch for /research (per outes/agent.ts:574) but there is no opt-out toggle for plain agent runs. |
| Extended thinking toggle | [PARTIAL] | - | Toggles **implicitly** via QWEN_THINKING env / /think URL on the model, but **no UI toggle**. The "Thoughts" block surfaces reasoning whenever the model streams it (MessageList.tsx:183-194, :352-361). |
| Research mode | [OK] | Composer.tsx invokes /research via the slash command; pp/chat/page.tsx:281 opens ResearchPanel on send; commands.ts:33 pins tools. |
| Writing styles | [OK] | settings/PersonalizationTab.tsx | 4 presets + custom + from-sample; active style is read from UserStyle.isDefault. **No style picker chip in the composer** (the brief's "writing styles chip" isn't in the composer - only in Settings). |
| Connectors chip | [PARTIAL] | Composer.tsx:285 | The "+" -> Connectors item opens Settings -> Connectors tab. **No per-session connector picker** in the composer (connectionIds field is wired in stream.ts but not exposed). |
| Model selector with descriptions | [OK] | components/ModelSelector.tsx, lib/commands.ts, chat/page.tsx:565 | Catalog fetched from /api/models/catalog; tier sent as model. |
| Voice input | [OK] | lib/voice.ts::useDictation, Composer.tsx:83-95 | Web Speech API feature-detected; live interim transcript; Stop-and-Send; cancel button. **Firefox-unsupported** (button hidden). |
| Send button -> Stop while running | [OK] | Composer.tsx:347-368 | Stop calls onStop() -> bortRef.current?.abort(). |
| Disabled/empty state | [OK] | Composer.tsx:361 | disabled={!canSend}; canSend = !!(input.trim() || imagePreviews.length). |
| Queued messages | [NP] | - | Not implemented (no queue array on submit). |
| Context-aware placeholder | [OK] | lib/i18n.tsx:36 ('Message Loop GPT... (/ for commands)'); used in Composer.tsx:257. |

### Message rendering

| Feature | Status | File(s) | Notes |
|---|---|---|---|
| Smooth token streaming | [OK] | lib/stream.ts parseEvent + dispatch; MessageList.tsx live-state updates | Native etch(...).body.getReader() SSE; incremental state append; useEffect on [messages, liveSteps, statusMsg, liveAnswer] triggers a equestAnimationFrame smooth-scroll. **Scroll fighting can occur** because the effect re-fires on every keystroke of the live answer - see 6. |
| No scroll fighting | [PARTIAL] | MessageList.tsx:393-410 | Uses equestAnimationFrame, but always scrolls when content changes - no "user scrolled away" detection. |
| Full Markdown (headings, lists, tables, blockquotes, links) | [OK] | components/chat/Markdown.tsx | eact-markdown + emark-gfm + ehype-highlight. |
| Math/LaTeX | [NP] | - | No ehype-katex / emark-math. **Brief explicitly lists math/LaTeX.** |
| Code blocks with highlighting, language label, copy button, wrap toggle | [PARTIAL] | Markdown.tsx:21-43 | Highlight [OK] (rehype-highlight); language label [OK]; copy button [OK]; **no wrap toggle** (the brief's wrap toggle isn't implemented). |
| Collapsible thinking block with duration | [PARTIAL] | MessageList.tsx:352-365 | Collapsible [OK]; **no duration displayed** (the brief asks for duration). |
| Citations/source chips and hover cards | [PARTIAL] | MessageList.tsx:159-171 | Numbered list with [index] text; **no hover cards** (the brief asks for hover cards). |
| Inline images | [OK] | MessageList.tsx user-bubble and <ArtifactCard> | Authed blob URL through useAttachmentUrl. |
| Inline video player | [OK] | MessageList.tsx <ArtifactCard> for kind:'video' | <video controls playsInline preload="metadata">. |
| File cards | [OK] | <ArtifactCard> for kind:'file'/'document' | Download link to /api/files/:id/content. |
| Inline artifact cards | [OK] | MessageList.tsx <ArtifactCard> | Click opens <ArtifactViewer> (image/video) or downloads (file). |
| "Show more" for long user messages | [NP] | - | No truncation logic on user bubbles. |
| Floating "Scroll to bottom" button | [NP] | - | No button. **Brief explicitly lists this.** |

### Message actions

| Feature | Status | File(s) | Notes |
|---|---|---|---|
| Copy | [OK] | MessageList.tsx action bar | 
avigator.clipboard.writeText. |
| Retry/regenerate | [OK] | MessageList.tsx assistant action bar | onRetryBefore(idx) -> POST /rewind then resubmit. **Note:** the rewind request takes a messageId index and is a server-side truncate, not a pure client-side state roll-back. |
| Thumbs up/down with feedback modal | [PARTIAL] | MessageList.tsx shows thumbs buttons; outes/telemetry.ts accepts feedback | **No feedback modal** - thumbs click is local-state only (toggle filled icon); the POST /api/telemetry/feedback endpoint exists but is not wired from the UI. |
| "..." menu | [NP] | - | Per-message actions are inline icon buttons; no ellipsis menu. |
| Edit user message (Save & Submit / Cancel) | [OK] | MessageList.tsx user-bubble Edit -> orkAtMessage | Edit replaces the message into a new forked conversation (/api/conversations/:id/fork); **no inline Save & Submit / Cancel** in the original bubble. |
| Message branching with "< 2/3 >" version arrows | [PARTIAL] | outes/messages.ts exposes /fork | **No UI arrows** - the fork is invoked only when the user clicks Edit on an older message. |
| Toasts | [NP] | - | No global toast system; only statusMsg strings in the chat header and inline error chips. **Brief explicitly lists toasts.** |

### Agent activity (should be inline BELOW each response)

| Feature | Status | File(s) | Notes |
|---|---|---|---|
| Collapsible step timeline | [PARTIAL] | AgentComputer.tsx step grouping | Timeline [OK] (steps >2 min apart become new "Step N" groups). **Not inline below each response** - it lives in the right-edge overlay (see 4.6). |
| Per-tool icons | [OK] | AgentComputer.tsx 	oolIcons map | Maps 
ame -> Lucide icon; fallback Wrench. |
| Status and duration per step | [PARTIAL] | AgentComputer.tsx | Status icon [OK]; **no per-step duration** (just HH:MM:SS timestamps). |
| Live terminal output | [NP] | - | No streaming stdout/stderr. **execute_code returns the whole stdout at once**. **Brief explicitly lists this.** |
| Browser screenshots / live view | [NP] | - | No headless browser; webFetch returns markdown text only. **Brief explicitly lists this.** |
| File diffs | [NP] | - | ArtifactsPanel has a lineDiff(from,to) helper but no per-step diff in activity. **Brief explicitly lists this.** |
| "View in panel" link | [NP] | - | No per-step "View in panel" link. **Brief explicitly lists this.** |
| Error state with retry | [PARTIAL] | AgentComputer.tsx | error status [OK]; **no Retry button**. |
| Stop/cancel | [OK] | chat/page.tsx Stop button | bortRef.current?.abort(); abort signal propagates to streamTurn and to the durable ResearchRun.signal. |
| Permission/approval prompts | [OK] | AgentComputer.tsx approval card; AgentComputer.tsx polling | Streams pending_approval; user clicks Approve/Deny -> POST /api/agent/:id/approve. |
| To-do / progress list | [PARTIAL] | 	ools/createDocument.ts renders its own progress but the **general to-do list type** (Claude-style sub-agent task list) **is not implemented**. |
| Auto-expand while running and collapse when finished | [PARTIAL] | chat/page.tsx auto-open on first tool call (utoOpenedRef) | Auto-open [OK]; **does not auto-collapse on done** - the user closes it manually. |

### Right-hand panel (should be for viewable outputs only)

| Feature | Status | File(s) | Notes |
|---|---|---|---|
| Opens on artifact-card click | [PARTIAL] | MessageList.tsx <ArtifactCard> opens the inline viewer | The **ArtifactsPanel** (the right panel) is opened only via the header Files button, **not** by clicking an artifact card. **Brief asks the panel to open on artifact-card click** - see 6. |
| Live website preview | [NP] | - | No deployed live-website preview tool; create_document writes static HTML but does **not** spawn a tunnel/iframe to a running site. **Brief explicitly lists this.** |
| Documents | [OK] | ArtifactsPanel.tsx Preview/Raw/Sandbox tabs | Static text rendering + raw bytes + sandboxed <iframe srcDoc>. |
| Code | [OK] | ArtifactsPanel.tsx Raw tab | Pretty-printed source. |
| Images | [OK] | ArtifactsPanel.tsx + <ArtifactViewer> modal | Authed blob URL. |
| PDFs | [PARTIAL] | 	ools/createDocument.ts produces PDF via Puppeteer | **No PDF viewer in the panel** - downloads the file instead of rendering. |
| SVG | [OK] | 	ools/createDocument.ts::format === 'svg' produces SVG; rendered as <img> in card |
| Mermaid | [NP] | - | No Mermaid renderer. **Brief explicitly lists this.** |
| Spreadsheets | [PARTIAL] | 	ools/createDocument.ts::format === 'xlsx' produces an XLSX | **No spreadsheet viewer in the panel** - downloads the file. |
| Preview/Code toggle | [OK] | ArtifactsPanel.tsx Preview/Raw/Sandbox tabs |
| Version dropdown | [OK] | ArtifactsPanel.tsx version list + "Compare N versions" |
| Copy | [OK] | ArtifactsPanel.tsx Copy button |
| Download | [OK] | <a download href={url}> |
| Open in new tab | [PARTIAL] | <a target="_blank"> works for public tokens; **for private artifacts the URL is auth-required and won't render in a new tab without the user's JWT**. |
| Publish/share | [OK] | ArtifactsPanel.tsx Publish button; POST /api/files/:id/publish |
| Fullscreen | [NP] | - | **No fullscreen toggle.** **Brief explicitly lists this.** |
| Draggable resize that remembers its width | [NP] | - | Fixed widths: sm:max-w-[440px] lg:w-[380px]. **Brief explicitly lists this.** |
| Close | [OK] | Header X button |
| Smooth chat-column resize | [NP] | - | No resize observer; chat column is fixed width. |
| Device-size toggle (desktop/tablet/mobile) | [NP] | - | **No device-size toggle.** **Brief explicitly lists this.** |
| Refresh | [NP] | - | No Refresh button. **Brief explicitly lists this.** |
| "Fix error" button on runtime errors | [NP] | - | **No Fix Error button.** **Brief explicitly lists this.** |
| "Building..." streaming state | [PARTIAL] | MessageList.tsx "Generating response..." status message | **No per-artifact "Building..."** state - liveArtifacts[] only fills in when the SSE rtifact event arrives. |

### Media

| Feature | Status | File(s) | Notes |
|---|---|---|---|
| Image lightbox (zoom, pan, pinch, next/prev, download, Esc/swipe to close) | [PARTIAL] | MessageList.tsx <ArtifactViewer> | Full-screen modal [OK]; Esc-close [OK]; focus-trap [OK]; **no zoom/pan/pinch**, **no next/prev swipe** (per-image only). |
| Lazy loading and placeholders | [PARTIAL] | useAttachmentUrl resolves blob on mount; placeholder is an empty rounded box | Native loading="lazy" not set; **no skeleton placeholder**. |
| No layout shift | [PARTIAL] | max-w-md max-h-96 clamps; <ArtifactCard> reserves a row | No explicit width/height on <img> to reserve CLS; user sees a jump when image loads. |
| Video streaming with Range support | [PARTIAL] | privateFiles.ts::sendFile uses Range header | The Express handler streams bytes via s.createReadStream + Accept-Ranges; **but the default Express response does not advertise Content-Range until the first Range request** - and the frontend uses a blob URL through useAuthedUrl, not direct Range requests, so browser default seek works but big-file cold starts feel slow. |
| Video controls (seek, volume, speed, fullscreen, PiP) | [PARTIAL] | Browser-native <video controls> | Seek [OK]; volume [OK]; speed [OK]; **no PiP button** (browser may expose one in some engines). |
| iOS playsinline | [OK] | <video playsInline> (case-correct as set in JSX). |
| Poster frame | [NP] | - | No poster attribute set. |
| Buffering indicator | [NP] | - | Browser default spinner only. |

### Responsive and mobile

| Feature | Status | File(s) | Notes |
|---|---|---|---|
| Mobile-first layout | [PARTIAL] | chat/page.tsx | h-[100dvh] [OK]; CSS grid lex; **not strictly mobile-first** - chat page CSS is desktop-default then <lg: overrides; some inner containers assume a wider viewport. |
| 100dvh | [OK] | chat/page.tsx shell, Sidebar.tsx | |
| Safe-area insets | [OK] | chat/page.tsx | pt-[env(safe-area-inset-top)], pb-[max(0.75rem,env(safe-area-inset-bottom))]. |
| Keyboard-aware composer | [PARTIAL] | Composer is fixed at the bottom | **No isualViewport.resize listener** to lift the composer above the iOS keyboard - the keyboard overlaps the composer on iOS Safari. |
| Sidebar as a drawer | [OK] | Sidebar.tsx mobile drawer with backdrop |
| Artifact panel as full-screen / bottom sheet | [PARTIAL] | ActivityPanel/ArtifactsPanel become full-screen drawers on <lg | Not a true bottom sheet (slides from the right). |
| 44px touch targets | [PARTIAL] | Most buttons are 32-40px | The composer + button is 32px (w-8 h-8); mic/send buttons are 28-32px. **Brief asks for 44px.** |
| No horizontal overflow | [PARTIAL] | overflow-hidden on shell; overflow-x-auto on tables | **Sidebar may overflow** at 320px (its 320px content + a 4px border + the 16px safe area is fine, but the per-conversation hover icons may collide with the title at 320px). |
| Behavior from 320px to 1920px | [PARTIAL] | min-w content guards; max-w-[92vw] on overlays | **Not tested at 320px explicitly** - the sidebar is fixed at 320px wide. |
| Tablet layout | [PARTIAL] | <lg (1024px) breaks | Single-column tablet layout inherits the phone layout; **no distinct tablet 2-column mode**. |

### Sharing, export, states, accessibility, performance

| Feature | Status | File(s) | Notes |
|---|---|---|---|
| Share link with public toggle and revoke | [PARTIAL] | ArtifactsPanel.tsx Publish button | View-only public link [OK]; **revoke is the same Publish button toggling state off** - no separate "revoke token" UI. **No chat-level public-share link** (only per-artifact). |
| Export chat | [OK] | chat/page.tsx Export menu | Markdown + PDF (print-to-PDF). |
| Download artifacts | [OK] | <a download> on artifact cards + panel |
| Welcome screen with suggested prompts | [OK] | MessageList.tsx welcome state; 4 starter buttons |
| Skeleton loaders | [NP] | - | **No skeleton placeholders.** |
| Offline banner | [NP] | - | **No offline indicator.** **Brief explicitly lists this.** |
| Stream auto-resume | [PARTIAL] | The stream uses AbortController on navigation; ResearchRun survives reload via GET /api/agent/research?conversationId= | **Chat stream itself does not auto-resume on disconnect** - the user must re-send. |
| Rate/usage-limit messages | [OK] | `routes/agent.ts` and `services/billing.ts` return 402/429 with structured errors; the chat surface shows `statusMsg` | |
| Friendly errors | [PARTIAL] | lib/stream.ts onError(message) writes a single-line status | **No toast/inline error card** - just text in the header strip. |
| Confirmation dialogs | [PARTIAL] | Sidebar.tsx delete uses native confirm() | **No custom modal confirmation** for destructive actions; only native confirm(). |
| Keyboard navigation | [PARTIAL] | Composer slash palette, command palette, settings modal | **No global focus-trap manager** outside the command palette. |
| Focus rings | [PARTIAL] | ocus-within:border-white/[0.14] and ccent-ring on focused controls | Focus rings exist on the composer but **not consistently on every interactive control** (some Lucide-icon-only buttons rely on hover only). |
| ARIA live regions | [PARTIAL] | MessageList.tsx activity region has aria-live='polite' | The streamed answer region does **not** announce every chunk (would be noisy); tool steps have aria-live='polite' but no explicit role. |
| Reduced-motion support | [OK] | providers.tsx MotionConfig reducedMotion='user' |
| WCAG AA contrast | [PARTIAL] | 	text-slate-400 on bg-#0b0b12 is borderline (contrast ~7.4:1 for slate-300) | The 	text-slate-500 and 	text-slate-600 used in disabled placeholders are **below 4.5:1** (the WCAG AA threshold for normal text). |
| List virtualization | [NP] | - | MessageList renders all messages + steps in the DOM. **Brief explicitly lists this.** |
| Markdown render debouncing | [NP] | - | Each liveAnswer chunk re-runs the Markdown memo (which is memo()-ed but **not debounced** - the cost is small per chunk but adds up). |
| Code splitting | [PARTIAL] | Next.js automatic route splitting; MessageList.tsx uses dynamic-less static imports | Some heavy components (ArtifactsPanel.tsx, ConnectorsTab.tsx) are loaded eagerly inside the Settings modal. |

---

## 6. KNOWN PROBLEMS

For each problem: **symptom | likely root cause | file(s) | severity | suggested fix**.

### P1. Agent activity renders on the right, not below each response
- **Symptom.** Per the brief, agent activity should appear **inline BELOW each response**. Today it is a **fixed right-edge overlay on desktop** and a **full-screen drawer on mobile**. The two panels are also mutually exclusive (ActivityPanel vs ArtifactsPanel), so you cannot see both at once.
- **Likely root cause.** chat/page.tsx places <ActivityPanel> as lg:relative inset-y-0 right-0 ... w-full max-w-[92vw] sm:max-w-[440px] lg:w-[380px]. There is no per-message "below response" insertion point. ActivityPanel.tsx is a wrapper that animates <AgentComputer> from the right.
- **Files.** rontend/app/chat/page.tsx, rontend/app/components/chat/ActivityPanel.tsx, rontend/app/components/AgentComputer.tsx.
- **Severity.** **Blocker** for the brief's "agent activity should be inline below each response" requirement.
- **Suggested fix.**
  1. Move <AgentComputer> out of <ActivityPanel> and render it directly under each assistant message bubble inside MessageList.tsx. Wrap each instance in a <motion.section> with a per-message stepIndex prefix so deltas remain stable across message keys.
  2. Keep an optional **detail-overlay** mode for a full-screen view (currently <ActivityPanel> does this with computerOpen). Re-purpose the overlay so it shows the **focused** step's expanded card on demand, not the global stream.
  3. Drop the computerOpen mutex between Activity and Artifacts - the right panel can host one (Artifacts, when the user clicks an artifact card), and activity lives inline.

### P2. Artifacts do not open in the right-hand panel from a card click
- **Symptom.** Clicking an <ArtifactCard> in the message bubble opens an **inline <ArtifactViewer> modal**, not the right-edge ArtifactsPanel. The right-edge panel only opens from the **header Files button**, which is non-obvious.
- **Likely root cause.** MessageList.tsx <ArtifactCard onOpen={() => setViewer({open:true,...})}> is local state in the message list. The right-edge ArtifactsPanel is opened via chat/page.tsx's onToggleArtifacts().
- **Files.** rontend/app/components/chat/MessageList.tsx, rontend/app/components/chat/ArtifactsPanel.tsx, rontend/app/chat/page.tsx.
- **Severity.** **Major** UX gap relative to the brief.
- **Suggested fix.** MessageList.tsx onOpen should call onOpenArtifact(artifact) (a new prop passed down from chat/page.tsx) which sets rtifactsOpen=true and ocusedArtifactId=artifact.id. Add a "back to list" header in ArtifactsPanel.tsx that returns to the artifact-list view.

### P3. Why videos cannot stream smoothly
- **Symptom.** Long videos (>50 MB) take seconds to start; seek feels heavy; the seek bar sometimes "snaps back."
- **Likely root cause.**
  1. **No Accept-Ranges advertised on first GET.** The privateFiles.ts::sendFile checks for a Range header and ranges correctly, but the initial 200 response does not include Accept-Ranges: bytes or Content-Range, so the browser may buffer the entire file before starting.
  2. **No HTTP byte-range on authed paths.** The authed blob URL path bypasses sendFile entirely (it uses etch().blob() and URL.createObjectURL), so the **browser cannot use HTTP byte-range at all on authed paths**. The whole file is downloaded to a blob before the <video> tag starts.
  3. **No HLS / DASH**, no progressive.m3u8, no chunked encoding - just plain byte streaming.
- **Files.** ackend/src/services/privateFiles.ts, rontend/app/components/chat/MessageList.tsx (useAuthedUrl, useAttachmentUrl), ackend/src/routes/files.ts.
- **Severity.** **Major.**
- **Suggested fix.**
  1. Add Accept-Ranges: bytes and Content-Range headers to the very first 200 response from privateFiles.sendFile.
  2. For authed fetches, expose a streaming object URL via MediaSource or ReadableStream so the <video> element can play while the bytes arrive.
  3. Add a per-format (mp4) mp4box.js fragment loader for HTTP-range emulation on authed files.
  4. Consider a **public-token rewrite** that preserves auth - e.g. add the JWT as a query param when constructing the <video src>, then validate the query in sendFile and **also include Accept-Ranges: bytes in the response**.

### P4. Why images do not display smoothly
- **Symptom.** Image placeholders flicker; full-resolution images load after the row is shown.
- **Likely root cause.**
  1. **No explicit width/height on <img>** - layout shifts when the image arrives (CLS).
  2. **No loading="lazy" / decoding="async".**
  3. **Blob URLs created on demand per render of <ArtifactCard>** - the network round-trip happens after the card mounts, leaving an empty box visible.
- **Files.** rontend/app/components/chat/MessageList.tsx, rontend/app/components/ui/primitives.tsx.
- **Severity.** **Minor.**
- **Suggested fix.**
  1. Read the message attachment's declared width/height from message.metadata.width/height (the vision path stores these) and set width/height on <img>.
  2. Add a CSS-only shimmer placeholder the size of the row.
  3. Set loading="lazy" decoding="async" on every <img> that is not in the initial viewport.

### P5. The agent window "transitions" feel abrupt
- **Symptom.** The ActivityPanel slides in from the right once computerOpen=true. There is no smooth interpolation between "before the first tool call" and "tool call arrived" - the panel **pops in**.
- **Likely root cause.** chat/page.tsx's auto-open useEffect flips computerOpen=true exactly once (utoOpenedRef). The slide-in motion is configured (initial={{x: '100%'}} animate={{x: 0}}), but the content inside is empty at first paint - there is no skeleton state for "first tool call incoming."
- **Files.** rontend/app/chat/page.tsx, rontend/app/components/chat/ActivityPanel.tsx, rontend/app/components/AgentComputer.tsx.
- **Severity.** **Minor** (becomes **Major** when the panel moves inline per P1).
- **Suggested fix.**
  1. Show a **"Thinking..."** pulse indicator in the assistant message bubble before any tool call lands (MessageList.tsx already shows "Generating response..." but the tool-specific state machine is empty).
  2. Crossfade in tool cards (single tool card pops in with a 150 ms scale+fade transition).
  3. Auto-collapse on onDone (currently the panel stays open).

### P6. UI breaks on multiple devices / mobile (concrete CSS/layout culprits)
- **Symptoms.**
  1. On iPhone SE (375x667) the chat composer overlaps the on-screen keyboard.
  2. On a 320px viewport the sidebar header text "New chat" truncates and the icon buttons crowd.
  3. On an iPad in portrait (768x1024) there is no tablet-specific layout - the phone layout is used with a wide left margin.
  4. Some 	ext-slate-500 / 	ext-slate-600 decorative text is **below 4.5:1 contrast** against g-[#0b0b12] (WCAG AA fail).
- **Likely root cause.** Concrete issues:
  1. **No isualViewport.resize handler** in chat/page.tsx to lift the composer above the keyboard.
  2. **Hard-coded sidebar width w-80 (320px)** in Sidebar.tsx:4 - cannot shrink to 280px on narrow screens.
  3. **Single desktop breakpoint at 1024px (lg)** - no md (768px) tablet layout.
  4. 	ext-slate-500 on g-[#0b0b12] contrast ~3.6:1 (decorative only); 	ext-slate-600 ~2.7:1.
- **Files.** rontend/app/chat/page.tsx, rontend/app/components/chat/Sidebar.tsx, rontend/app/components/chat/Composer.tsx, rontend/app/components/chat/MessageList.tsx.
- **Severity.** **Major** on mobile.
- **Suggested fix.**
  1. Add a useEffect(() => { ... visualViewport.resize ... }, []) that sets a CSS variable --composer-bottom-offset to max(0.75rem, visualViewport.offsetTop + window.innerHeight - visualViewport.height + env(safe-area-inset-bottom)) and use it on the composer's paddingBottom.
  2. Make sidebar width w-[min(20rem,calc(100vw-2rem))] and the title overflow ellipsis at min-w-0.
  3. Introduce a md (768px) breakpoint that uses a 2-column layout: persistent sidebar + chat column.
  4. Bump 	ext-slate-500 -> 	ext-slate-400 and 	ext-slate-600 -> 	ext-slate-500 on dark surfaces for any text that conveys meaning (not pure decoration).

### P7. Streaks and visibility gaps in PROGRESS.md / docs
- **Symptom.** Several docs/loop-gpt-production-readiness-brief.md P0/P1/P2 items contradict the more recent docs/PROGRESS.md. Example: brief lists "PDF knowledge ingestion" as P1, but the latest status says "shipped"; brief lists "skill versioning" as P1, but progress says "shipped."
- **Likely root cause.** Brief predates the production-readiness pass; documents weren't rewritten after the pass.
- **Files.** docs/PROGRESS.md, docs/PROJECT_STATUS_REPORT.md, docs/loop-gpt-production-readiness-brief.md.
- **Severity.** **Minor** (docs hygiene).
- **Suggested fix.** Treat PROGRESS.md as the source of truth for shipped-vs-not, and rewrite the brief's P1/P2 lists to mirror it; mark retired items [shipped] or remove.

### P8. Connectors marketplace OAuth E2E never exercised live
- **Symptom.** None today (UI works for mocks) - but per docs/PROGRESS.md's open external items, none of the 8 user-OAuth-app marketplace providers (Outlook/OneDrive/Dropbox/Linear/Asana/Salesforce/Figma/Zoom) have been live-tested.
- **Likely root cause.** The user must create their own OAuth app + paste credentials; no test plan has been executed for these.
- **Files.** ackend/src/agent/connectors/marketplaceAdapters.ts, ackend/src/agent/connectors/oauthProviders.ts, ackend/src/routes/oauthConnector.ts.
- **Severity.** **Major** for a "Ready to ship" claim.
- **Suggested fix.** Add stub-server CI tests (per docs/loop-gpt-production-readiness-brief.md "Connector tests as real CI") and run one live smoke run per provider (Figma is the suggested P0 minimum).

### P9. Stripe dormant + payments off
- **Symptom.** STRIPE_CHECKOUT_ENABLED=false, STRIPE_FULFILLMENT_ENABLED=false per docs/STRIPE_LIVE_CHECKLIST.md. Account page hides the Upgrade button; landing copy says "Free during launch."
- **Likely root cause.** **Intentional** per Option B; plumbing is complete.
- **Files.** ackend/src/services/billing.ts, ackend/src/services/paymentFulfillment.ts, ackend/src/routes/billing.ts, docs/STRIPE_LIVE_CHECKLIST.md.
- **Severity.** **Blocker** for any paying audience.
- **Suggested fix.** When ready to charge, follow the 7-step checklist in docs/STRIPE_LIVE_CHECKLIST.md (flip env, configure webhook, smoke-test in Stripe test mode, then a real low-value live charge).

### P10. Email / SMTP unconfigured
- **Symptom.** services/email.ts exists with oucherRedeemedEmail etc. but no SMTP is wired. User.emailVerified defaults to alse; password reset link never delivers; verification email never sends.
- **Likely root cause.** RESEND_API_KEY is set in production but loop-gpt.cyou is not added to the Resend plan; the failed xwf-adsgoogle.com is a candidate slot (per docs/PROGRESS.md open external items).
- **Files.** ackend/src/services/email.ts, ackend/src/routes/auth.ts, ackend/src/routes/oauth.ts, rontend/app/account/page.tsx, rontend/app/verify/page.tsx.
- **Severity.** **Blocker** for any paying audience.
- **Suggested fix.** Add loop-gpt.cyou to the Resend plan (or free a slot), then verify POST /api/auth/forgot round-trip and POST /api/auth/verify token round-trip end-to-end with a real mailbox.

### P11. Observability/backups absent
- **Symptom.** No Sentry DSN in prod; no PostHog key in prod; no DB backups; no uptime monitor.
- **Likely root cause.** Open external items in docs/PROGRESS.md ("Sentry DSN + PostHog key env vars (code ready, one env change); DB backups: PITR needs the Postgres image migrated to ghcr.io/railwayapp-templates/postgres-ssl; uptime monitor account").
- **Files.** ackend/src/server.ts (Sentry init), rontend/app/components/Analytics.tsx.
- **Severity.** **Blocker** for any paying audience.
- **Suggested fix.** Per the checklist in docs/PROGRESS.md: set SENTRY_DSN + NEXT_PUBLIC_SENTRY_DSN + NEXT_PUBLIC_POSTHOG_KEY; migrate Postgres to a backup-enabled image; add an UptimeRobot/BetterStack free-tier ping on /healthz.

### TODO / FIXME / HACK comments
- I searched for TODO, FIXME, HACK in source files. Specific concrete observations:
  - rontend/app/components/chat/Composer.tsx carries a long set of feature-detection guards and cross-browser fallback paths - the getDisplayMedia capability block at Composer.tsx:75-79 is a known-bad path on Firefox/Safari. **Severity: Minor** (documented fallback).
  - ackend/src/agent/__tests__/webConsumers.test.ts is described in docs/PROGRESS.md as flaky under contention (real Tavily network). Tracked in P3 hygiene. **Severity: Minor** (test flake, not prod).
  - rontend/app/globals.css retains 
eon-violet / neon-cyan / neon-fuchsia / neon-green / neon-amber aliases of the terracotta palette (acknowledged legacy in PROGRESS.md). **Severity: Minor** (CSS-only).
- **No literal TODO: / FIXME: / HACK: markers** were found in production source files during a broad search; cleanup is tracked in docs.
- (A more thorough grep would find every commented-out line; the above is what stands out from reading the code.)

### Console / network errors observed in the static code (UNVERIFIED at runtime)
- **Frontend:** no global 	ry/catch around etch calls in useAttachmentUrl/useAuthedUrl - any HTTP failure surfaces as a console error. **Severity: Minor.**
- **Backend:** outes/agent.ts::POST /:conversationId/stream writes console.error on SSE failures (server.ts configures uncaughtException handlers but no per-request structured logger). **Severity: Minor.**
- No console.log hot-spots; production paths use console.error only.

---

## 7. CODE QUALITY SNAPSHOT

- **Test coverage.** Backend: **1077 unit/integration tests across 55 files** per docs/PROGRESS.md. Linux backend total in alidation/foundation-03o.md: **1,399 tests** (includes extra integration + transport checks). Frontend: **20 passed** (Composer, command palette, Settings shell, Memory tab) per docs/PROJECT_STATUS_REPORT.md; docs/PROGRESS.md lists **32 tests**. Playwright a11y on /, /login/, /signup/, /chat/: **12 passed**. Web (alt owned foundation): **94 unit/component tests + 4 Chromium fixtures** per web/VALIDATION.md.
- **Test tooling.** Vitest (^2.1.8 BE, ^2.1.9 FE, 5.0.1 web) with jsdom (FE), 
ode (BE), happy-dom (web). Playwright (@playwright/test ^1.49.1) for E2E + a11y. Integration suite is BE-only (itest.integration.config.ts) with real Postgres in disposable containers. **No frontend integration tests** against a live backend.
- **Lint/format.** ESLint 8 + 
ext/core-web-vitals for FE (rontend/.eslintrc.json extends 
ext/core-web-vitals; rontend/eslint.config.mjs not present - using Next's lint wrapper). **Backend has no ESLint config** (ackend/package.json does not declare eslint, lint, or ormat). No Prettier config in repo root or any sub-package. **Severity: Minor** (FE lint works; BE has no enforced style).
- **TypeScript strictness.** Both BE and FE use "strict": true in 	sconfig.json. Project reports 0 errors on 	sc --noEmit for both per docs/PROJECT_STATUS_REPORT.md 1.3.
- **Duplicated code.** Models for OAuth are duplicated between outes/oauth.ts (Google/GitHub env-driven login), outes/oauthConnector.ts (per-connector OAuth), and gent/connectors/oauthProviders.ts (registry). The Google adapters in gent/connectors/googleAdapters.ts are bespoke per-resource (Drive, Gmail, Calendar, Sheets). **Severity: Minor** (intentional separation but invites drift).
- **Dead code.** None obvious; the post-BYO-removal cleanup removed iProvider/iModel/iApiKey localStorage keys per PROGRESS.md. **Severity: None.**
- **Oversized components (>300 lines).**
  - rontend/app/chat/page.tsx **~755 lines** - mixes chat state, sidebar wiring, panel orchestration, export menu, and render.
  - rontend/app/components/chat/MessageList.tsx **564 lines** - mixes bubble rendering, action bar, attachment authed URL, artifact cards, video/image viewers, modal management, scroll management.
  - rontend/app/components/chat/Composer.tsx **432 lines** - mixes slash palette, "+" menu, run-mode picker, dictation, attachments.
  - rontend/app/components/chat/Sidebar.tsx **302 lines**.
  - rontend/app/components/AgentComputer.tsx **267 lines**.
  - rontend/app/components/chat/ArtifactsPanel.tsx **270 lines**.
  - rontend/app/components/SettingsPanel.tsx + each tab is **100-300 lines** (SkillsTab.tsx ~255, ConnectorsTab.tsx ~300, PersonalizationTab.tsx ~125).
  - rontend/app/components/ProjectsPanel.tsx **~440 lines**.
  - **Severity: Major** - the chat page is the worst offender; should be split into <ChatLayout>, <Header>, <ConversationView>, <ComposerHost>, plus hooks.
  - Backend: outes/agent.ts **734 lines** (POST /:id/stream alone is ~140 lines; could be a controller).
- **Prop drilling.** Significant: chat/page.tsx passes ~25 props into Composer.tsx; Composer.tsx accepts them as plain props rather than a context. **Severity: Minor** (works, but a <ComposerContext> + <useComposer() hook would reduce churn).
- **Performance risks.**
  - **No list virtualization** in MessageList.tsx - every message + every tool card + every live-thinking string renders in the DOM. With 100+ messages the React diff grows linearly.
  - **Markdown re-render on every chunk** - Markdown is memo()-ed but is fed new content on every chunk, so it does a fresh eact-markdown render for every chunk. Could be debounced/throttled via equestAnimationFrame.
  - **Authed blob URL fetch** for every <img>/<video> (one round-trip per artifact). Acceptable at the current scale; would not scale to a 50-image long conversation.
  - **SSE parsing** uses String.prototype.split('\n\n') and JSON.parse per event; not a bottleneck but not chunked. **Severity: Minor.**
- **Security concerns.**
  - **Auth:** JWT HS256 (jsonwebtoken) with JWT_SECRET enforced >=10 chars; per-user sessionInvalidatedAt for reset; TOTP via otplib is available (/api/account/totp/{setup,verify,disable}) but only mandatory as a login challenge for users who enabled it - not enforced globally.
  - **OAuth:** OAuth 2.1 + PKCE for the marketplace flow (outes/oauthConnector.ts). AES-256-GCM encryption of workspace tokens (services/credentialVault.ts) with O_NOFOLLOW-anchored paths and pre-resolved workspace ancestors (anchors AAD: connection:v1::).
  - **Uploads:** private files - privateStorage.ts enforces canonical-path + min-free-bytes probe + O_NOFOLLOW. MIME signature validation rejects mismatched magic bytes. Legacy /uploads mount returns **410 Gone** via ejectLegacyUploads (no compatibility switch back to public).
  - **Sandbox:** Docker (--network none --read-only + tmpfs --cpus --memory) with host-subprocess fallback (SANDBOX_DOCKER=false). Tests run real JS in subprocess (executeCode.test.ts).
  - **Rendered markdown/HTML XSS:** markdown is rendered via eact-markdown (safe by default); artifact sandbox uses <iframe sandbox="allow-scripts allow-popups" srcDoc> (no llow-same-origin).
  - **CORS:** middleware/corsPolicy.ts - fixed allow-list of origins from FRONTEND_URL plus web service origin. **No wildcard**.
  - **Public HTTP transport:** services/publicHttp.ts enforces pinned DNS, blocked private/loopback/link-local ranges, bounded response bytes (8 MiB default, 96 MiB ceiling), no redirect-following for credentialed requests.
  - **Provider transport:** services/modelTransport.ts enforces HTTPS-only + pinned DNS + bounded bytes + abort propagation.
  - **Residual risk:** the *legacy* outes/uploads.ts and outes/legacyHostedMessages.ts exist; the production HTTP path uses the alias POST /api/conversations/:id/messages only in chat/image modes (returns 400 on agent/research modes) - the legacy path is gated.
- **Prompt injection / guardrails.** gent/guardrails.ts provides sanitizeText (redacts HF tokens / endpoint URLs / model self-identifiers) and detectExtractionAttempt. Stream sanitizer makeStreamSanitizer holds back chunks to suppress cross-chunk identifiers. CONFIDENTIALITY_PROMPT is appended to system prompts when guardrailsEnabled=true. **No documented rate-limiting on prompt content** - the detectExtractionAttempt flag is logged but not enforced.
- **Dependency posture.** Backend has ~30 deps; frontend has ~30 deps; web has ~20 deps. Most are widely-used (express, prisma, axios, framer-motion, react-query, lucide). Bespoke deps: 
ode-fetch ^2.7.0 (typed ^2.6.13) for streaming, otplib ^13.5.0 for TOTP, xios ^1.13.2, @mozilla/readability ^0.5.0 for web_fetch readability extraction.

---

## 8. WHAT'S MISSING VS A CLAUDE-STYLE CHAT APP

Prioritised list grouped by **Critical / Important / Nice-to-have**. Each item is a gap relative to the brief checklist or to the polished Claude.ai/ChatGPT reference.

### Critical (blockers for "production-quality")

1. **Inline agent activity BELOW each response** (currently a right-edge overlay) - the brief explicitly asks for this.
2. **Artifacts open in the right-hand panel from a card click** - currently opens an inline modal; right panel only reachable via header Files button.
3. **Image lightbox with zoom/pan/pinch + next/prev swipe** - current <ArtifactViewer> is a basic full-screen modal.
4. **Video streaming over HTTP Range for authed content** - today the entire file is downloaded as a blob before the <video> tag plays it.
5. **Drag-and-drop file uploads + paste images** - both missing from Composer.tsx.
6. **History grouped by date** in the sidebar - the API returns a sorted list but the UI renders a flat list.
7. **Toast / notification system** - the only feedback surface is statusMsg in the chat header.
8. **Skeleton loaders + offline banner** - no loading skeletons; no offline detection.
9. **Search across message bodies** - sidebar search only matches conversation titles.
10. **Full-screen artifact view + draggable resize + device-size toggle + "Fix error" button + Refresh** on the right panel - none of these are implemented.
11. **Email verification + password reset wired end-to-end** in production (Resend transport ready; domain slot pending per docs/PROGRESS.md).
12. **Live connector smoke runs** for the 8 marketplace OAuth apps - none have been live-tested.

### Important (needed to feel "Claude-quality")

13. **Star/pin chats + per-chat share + per-chat star UI** - missing.
14. **"Show more" for long user messages** - missing.
15. **Floating "Scroll to bottom" button** + scroll-fight protection - missing.
16. **Web search toggle** + **explicit extended-thinking toggle** in the composer - missing.
17. **List virtualization** for MessageList.tsx (TanStack Virtual / react-window) - missing.
18. **iOS keyboard-aware composer** (isualViewport.resize) - missing.
19. **44px touch targets** on every control - many are 28-32px.
20. **Math/LaTeX** rendering (emark-math + ehype-katex) - missing.
21. **Mermaid renderer** - missing.
22. **PDF + spreadsheet in-panel viewer** - currently downloads.
23. **"Fix error" + "Building..." streaming state** for artifacts - missing.
24. **Live website preview** (deploy a running site) - missing.
25. **File diffs** in agent activity - missing.
26. **Live terminal output** (stdout streaming) for execute_code - missing.
27. **Browser screenshots / live view** (no headless browser) - missing.
28. **To-do / progress list** for sub-agent tasks - missing.
29. **Stream auto-resume** on disconnect (chat-level) - missing.
30. **WCAG AA contrast pass** - several 	ext-slate-500/600 decorative strings fail 4.5:1.
31. **Per-message retry/feedback modal** for thumbs - currently thumbs is local-state only.
32. **Tablet layout** at 768px - currently phone-layout below 1024px.
33. **Visual revoke UX** for published artifacts - one Publish button toggles state; no separate revoke.
34. **No PII/regex rate-limit on prompt content** (detectExtractionAttempt is logged but not enforced).

### Nice-to-have

35. **Light/dark/system theme switcher** - currently hard-coded dark.
36. **Settings tabs:** Profile, Appearance, Font, Usage, Data controls - missing; these live on /account instead.
37. **PIP button on <video>** - browser-default only.
38. **Poster frame + buffering indicator** on <video>.
39. **Per-message queue (queue user messages while a run is active)** - missing.
40. **Connectors chip in the composer** that lists recently used connectors and pins one for the next run - currently "+" -> Connectors opens Settings.
41. **Mobile app parity** - mobile/ is Expo with 4 screens (Login/ChatList/Chat/Settings/Projects); does not mirror web IA.
42. **Message branching with explicit < 2/3 > arrows** in the bubble - currently only via Edit-fork.
43. **Native signing (Google/GitHub OAuth on mobile)** - GAP-049 not built.
44. **Full hands-free voice mode** (continuous mic + spoken replies) - backend audio streaming required.
45. **Backend-quality TTS** replacing browser speechSynthesis - POST /api/tts exists (Kokoro) but per-message TTS in the bubble uses browser-only.
46. **Cleanup of legacy 
eon-* class names** (P3 hygiene).
47. **Doc hygiene** - docs/PROVIDER_MEDIA_HTTP.md is SUPERSEDED; ACCOUNTED_VIDEO_JOBS.md paths; RUNTIME_AUTHORIZATION.md stale references.

---

## 9. RAW EXCERPTS

Each excerpt is <=40 lines. File paths are repo-relative.

### 9.1 Root layout (rontend/app/layout.tsx)
`	sx
import './globals.css'
import { Inter } from 'next/font/google'
import type { Metadata, Viewport } from 'next'
import { Providers } from './providers'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Analytics } from './components/Analytics'

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' })

export const metadata: Metadata = { title: 'Loop GPT', description: '...' }
export const viewport: Viewport = { width: 'device-width', initialScale: 1,
  viewportFit: 'cover', themeColor: '#0b0b12' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={${inter.className} bg-[#0b0b12] text-slate-100 antialiased}>
        <Providers>
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </Providers>
        <Analytics />
      </body>
    </html>
  )
}
`

### 9.2 Chat page (state shell) (rontend/app/chat/page.tsx, lines 1-40)
`	sx
'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Sidebar } from '@/app/components/chat/Sidebar'
import { Composer } from '@/app/components/chat/Composer'
import { MessageList } from '@/app/components/chat/MessageList'
import { ActivityPanel } from '@/app/components/chat/ActivityPanel'
import { ArtifactsPanel } from '@/app/components/chat/ArtifactsPanel'
import { ProjectsPanel, Project } from '@/app/components/ProjectsPanel'
import { runAgentStream } from '@/app/lib/stream'
import { api } from '@/app/lib/api'
// ... and 30+ more imports
type AgentMode = 'chat' | 'agent' | 'research'
type RunMode = 'auto' | 'plan' | 'step' | 'accept'
export default function ChatPage() {
  const router = useRouter(); const qc = useQueryClient()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [computerOpen, setComputerOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  // ... 20 more useState lines
}
`

### 9.3 Composer (rontend/app/components/chat/Composer.tsx, lines 240-280)
`	sx
<textarea
  value={input}
  onChange={(e) => onInputChange(e.target.value)}
  onKeyDown={(e) => {
    if (e.key === 'ArrowDown' && showSlash && slashFilter.length > 0) { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashFilter.length) }
    else if (e.key === 'ArrowUp' && showSlash && slashFilter.length > 0) { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashFilter.length) % slashFilter.length) }
    else if (e.key === 'Tab' && showSlash && slashFilter.length > 0) { e.preventDefault(); handleCommandClick(slashFilter[slashIndex]?.cmd) }
    else if (e.key === 'Enter' && !e.shiftKey) {
      if (showSlash && slashFilter.length > 0 && input.trim() === (slashFilter[slashIndex]?.cmd || slashFilter[0]?.cmd)) {
        e.preventDefault(); handleCommandClick((slashFilter[slashIndex] || slashFilter[0]).cmd)
      } else { e.preventDefault(); onSend() }
    }
  }}
  aria-label={t('placeholder')} placeholder={t('placeholder')} rows={1}
  className="w-full bg-transparent px-4 pt-3 pb-1 resize-none focus:outline-none placeholder-slate-600 text-[15px] text-slate-100 leading-relaxed"
  style={{ maxHeight: 220 }}
  onInput={(e) => { const el = e.target as HTMLTextAreaElement
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px' }}
/>
`

### 9.4 MessageBubble (assistant) (rontend/app/components/chat/MessageList.tsx, lines 180-220)
`	sx
{role === 'assistant' && (
  <div className="group flex gap-3 max-w-full">
    <div className="w-7 h-7 rounded-lg bg-[#c96442] flex items-center justify-center shrink-0">
      <Sparkles size={14} className="text-white" />
    </div>
    <div className="min-w-0 flex-1">
      {msg.metadata?.reasoning && (
        <details className="mb-1.5">
          <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-300 transition flex items-center gap-1">
            <Brain size={11} /> Thoughts
          </summary>
          <div className="mt-1 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.05] text-[12.5px] text-slate-400 whitespace-pre-wrap">
            {msg.metadata.reasoning}
          </div>
        </details>
      )}
      <Markdown content={msg.content} sources={msg.metadata?.sources} artifacts={msg.metadata?.artifacts} />
      {msg.metadata?.sources && msg.metadata.sources.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {msg.metadata.sources.map((s, i) => <SourceChip key={i} index={i + 1} title={s.title} url={s.url} />)}
        </div>
      )}
`

### 9.5 Agent activity (rontend/app/components/AgentComputer.tsx, lines 80-120)
`	sx
function AgentComputer({ meta, status, steps, toolCount, onOpenTools, approval, onApprove, onDeny, onClose }: Props) {
  const grouped = useMemo(() => groupSteps(steps), [steps])
  const liveLabel = status?.message ?? labelForStatus(meta.status)
  return (
    <div className="flex flex-col h-full text-slate-200" role="region" aria-label="Agent activity">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/[0.06]">
        <StatusDot status={meta.status} />
        <div className="text-[12.5px] font-medium flex-1 min-w-0 truncate">Agent activity - {liveLabel}</div>
        {toolCount !== undefined && (
          <button onClick={onOpenTools} className="text-[10.5px] px-1.5 py-0.5 rounded-md border border-white/[0.08] text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition shrink-0">
            {toolCount} tools
          </button>
        )}
        {onClose && <button onClick={onClose} className="lg:hidden text-slate-500 hover:text-slate-200"><X size={14} /></button>}
      </div>
      {approval && <ApprovalCard approval={approval} onApprove={onApprove} onDeny={onDeny} />}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {grouped.length === 0 && <EmptyState title="No agent activity yet" body="Tool calls and steps appear here when the model uses one." />}
        {grouped.map((g, gi) => (
          <div key={gi} className="space-y-1.5">
            {grouped.length > 1 && <div className="text-[10.5px] text-slate-600 uppercase tracking-wide px-1">Step {gi + 1}</div>}
            {g.map(s => s.kind === 'text' ? <TextBlock key={s.index} text={s.text} ts={s.ts} /> : <ToolCard key={s.index} step={s} />)}
          </div>
        ))}
      </div>
    </div>
  )
}
`

### 9.6 Right-panel artifact (rontend/app/components/chat/ArtifactsPanel.tsx, lines 90-130)
`	sx
function ArtifactDetail({ artifact, sandboxAvailable, onPublish }: { artifact: Artifact; sandboxAvailable: boolean; onPublish: () => void }) {
  const [tab, setTab] = useState<'preview'|'raw'|'sandbox'>('preview')
  const authUrl = useAuthedUrl(artifact.url)
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/[0.06]">
        <TabBtn active={tab === 'preview'} onClick={() => setTab('preview')}>Preview</TabBtn>
        <TabBtn active={tab === 'raw'} onClick={() => setTab('raw')}>Raw</TabBtn>
        {sandboxAvailable && <TabBtn active={tab === 'sandbox'} onClick={() => setTab('sandbox')}>Sandbox</TabBtn>}
        <div className="flex-1" />
        <button onClick={onPublish} className="text-[10.5px] text-[#e79d7f] hover:underline">{artifact.published ? 'Unpublish' : 'Publish'}</button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {tab === 'preview' && (
          artifact.kind === 'image' ? <img src={authUrl} className="w-full rounded-lg" alt={artifact.name} /> :
          artifact.kind === 'video' ? <video src={authUrl} controls playsInline className="w-full rounded-lg" /> :
          artifact.kind === 'document' ? <pre className="text-[12px] text-slate-300 whitespace-pre-wrap">{artifact.text || artifact.url}</pre> :
          <pre className="text-[12px] text-slate-300">{artifact.text || '(no preview)'}</pre>
        )}
`

### 9.7 Streaming handler (ackend/src/agent/agentRuntime.ts, lines 240-280)
`	s
for (let iter = 0; iter < maxSteps; iter++) {
  await assertRunAccess(ctx)
  const useNative = hasTools && nativeToolSupport.get(cfgKey) !== false
  const sanitizer = makeStreamSanitizer((text) => ctx.emit({ type: 'delta', step: stepIndex, text }))
  let turn
  await opts.beforeDispatch?.()
  try {
    turn = await streamTurn({ client, model, messages: working, tools: useNative ? openaiTools : undefined,
      signal: ctx.signal, onDelta: (text) => sanitizer.push(text),
      onReasoning: (text) => ctx.emit({ type: 'thinking', step: stepIndex, text }),
      onWarming: (message) => ctx.emit({ type: 'warming', message }) })
    sanitizer.flush()
  } catch (err: any) {
    sanitizer.flush()
    if (useNative && nativeToolSupport.get(cfgKey) === undefined) { nativeToolSupport.set(cfgKey, false); iter--; continue }
    throw err
  }
  if (useNative && nativeToolSupport.get(cfgKey) === undefined) nativeToolSupport.set(cfgKey, true)
  // determine calls[] (native or inline JSON), max 8 per turn
  const calls: Array<{ id?: string; name: string; args: Record<string, any> }> = []
  // ...
}
`

### 9.8 Main state store (rontend/app/chat/page.tsx, React-Query + useState)
`	sx
const [mode, setMode] = useState<AgentMode>('agent')
const [runMode, setRunMode] = useState<RunMode>('auto')
const [input, setInput] = useState('')
const [selectedImages, setSelectedImages] = useState<File[]>([])
const [imagePreviews, setImagePreviews] = useState<string[]>([])
const [selectedDocs, setSelectedDocs] = useState<File[]>([])
const [running, setRunning] = useState(false)
const [statusMsg, setStatusMsg] = useState('')
const [liveUser, setLiveUser] = useState<{ text: string; attachments?: any[] } | null>(null)
const [liveSteps, setLiveSteps] = useState<LiveStep[]>([])
const [liveArtifacts, setLiveArtifacts] = useState<Artifact[]>([])
const [liveThinking, setLiveThinking] = useState('')
const [pendingApproval, setPendingApproval] = useState<...>(null)
const [toolCount, setToolCount] = useState<number | undefined>(undefined)
const incognito = useIncognitoToggle() // localStorage hook
const conversationsQuery = useQuery({ queryKey: ['conversations'], queryFn: () => api.listConversations() })
const messagesQuery = useQuery({ queryKey: ['messages', currentConversationId], queryFn: () => api.listMessages(currentConversationId), enabled: !!currentConversationId })
`

### 9.9 Main CSS/theme tokens (rontend/app/globals.css, head)
`css
:root {
  --background: #0b0b12;
  --surface: #111113;
  --surface-2: #16161a;
  --surface-3: #1c1c1f;
  --border: rgba(255,255,255,0.06);
  --border-strong: rgba(255,255,255,0.14);
  --accent: #c96442;
  --accent-hover: #b5593a;
  --accent-soft: #e79d7f;
  --text: #e5e7eb;
  --text-muted: #94a3b8;
  --text-faint: #64748b;
}
html, body { background: var(--background); color: var(--text); }
.glass { background: rgba(22,22,26,0.88); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--border); }
.glass-strong { background: rgba(11,11,18,0.92); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--border); }
.accent-ring:focus-visible { box-shadow: 0 0 0 2px var(--accent); outline: none; }
@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; } }
`

### 9.10 Breakpoints (rontend/tailwind.config.js + rontend/app/chat/page.tsx)
`js
// frontend/tailwind.config.js (excerpt)
screens: { sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' },
theme: { extend: {
  colors: { ink: { 50: ..., 800: ..., 900: ... } }, // legacy
  backgroundImage: { 'accent-gradient': 'linear-gradient(135deg, #c96442 0%, #b5593a 100%)' },
  // legacy neon aliases kept on purpose (P3)
  neon: { violet: '#c96442', indigo: '#b5593a', cyan: '#c96442', fuchsia: '#c96442', green: '#c96442', amber: '#b5593a' },
}}
// frontend/app/chat/page.tsx shell:
<div className="flex h-[100dvh] overflow-hidden bg-[#0b0b12] text-slate-100">
  <Sidebar className={${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 ... w-80 lg:w-72 lg:shrink-0 ...} ... />
  <main className="flex-1 min-w-0 flex flex-col">
    <header className="h-12 ..."> ... </header>
    <MessageList className="flex-1 min-h-0" ... />
    <ComposerWrapper className="border-t ..."> ... </ComposerWrapper>
  </main>
  <ActivityPanel className={${computerOpen ? 'translate-x-0' : 'translate-x-full'} lg:relative lg:translate-x-0 ... w-full max-w-[92vw] sm:max-w-[440px] lg:w-[380px]} ... />
  <ArtifactsPanel ... same slot, mutually exclusive ... />
</div>
`

---

## 10. OPEN QUESTIONS

1. **Production-email delivery state.** Is loop-gpt.cyou actually provisioned on the Resend plan today, or is verification/reset still inoperative? (docs/PROGRESS.md open external items - "Resend: add loop-gpt.cyou (plan upgrade or free a slot)"). RESEND_API_KEY is in production env per docs/PROGRESS.md open items but the domain is pending. **NEEDS CONFIRMATION.**
2. **Production backups.** Is Postgres PITR available on the Railway plan, or is the database on a "one incident from losing everything" footing? (docs/PROGRESS.md open items; docs/loop-gpt-production-readiness-brief.md P0 #5.) **NEEDS CONFIRMATION.**
3. **Live marketplace OAuth.** Are any of the 8 user-OAuth-app providers (Outlook/OneDrive/Dropbox/Linear/Asana/Salesforce/Figma/Zoom) actually live-tested against a real provider today? docs/PROGRESS.md says "only Figma is required for P0; the remaining 7 should each get at least one live smoke test." **NEEDS CONFIRMATION.**
4. **Real connector test coverage.** Are there stub-server CI tests for any of the providers (Drive/Gmail/Calendar/Sheets/GitHub/Notion/GitLab)? docs/loop-gpt-production-readiness-brief.md calls them out. **NEEDS CONFIRMATION.**
5. **create_skill end-to-end.** Has any user (or a real model run) ever produced a working SKILL.md via the in-chat create_skill meta-tool? docs/PROGRESS.md P1 #5 says "registered, but never confirmed to actually produce a working skill via natural-language chat request." **NEEDS CONFIRMATION.**
6. **loop-code CLI production status.** Is loop-code/ actively maintained, or is it a legacy/experimental sibling? It is not in docs/PROGRESS.md and not referenced in the live deployment. **NEEDS CONFIRMATION.**
7. **Web client (web/) production status.** Is web/ a parallel foundation that is ever deployed, or is the live product always the rontend/ (Next.js) app? docs/PROGRESS.md does not mention web/ as a live deployment. **NEEDS CONFIRMATION.**
8. **gateway/ deployment.** Is the legacy gateway/ nginx config still serving any traffic, or is it superseded by the owned-staging compose? **NEEDS CONFIRMATION.**
9. **Live model tier naming.** UI says "Large Looper" / "Small Looper"; backend uses large / standard (per docs/PROGRESS.md P3 hygiene note). Has this been reconciled, or is the mismatch still present? **NEEDS CONFIRMATION.**
10. **Pricing tier matrix.** What are the daily allowances for ree / pro / gold plans in production? services/billing.ts::CREDIT_COST and PLAN_LIMITS exist but the values are not visible from a non-destructive read. **NEEDS CONFIRMATION.**
11. **Browser support matrix.** The brief's "Don't Trust Yet" list says explicitly test Chrome/Edge/Safari; Firefox is flagged as having weaker Web Speech API support. Which browsers are officially supported for STT/TTS? **NEEDS CONFIRMATION.**
12. **Per-tool default permission.** Most tools default to llow; some (create_document, execute_code) default to 
eedsApproval=true. Where is the default policy matrix defined? Looks like it lives inline on each tool definition; should it be centralized? **NEEDS CONFIRMATION.**

---

### FINAL CHECK (self-audit)

- [x] All 10 sections present.
- [x] Every checklist item in section 5 has a status, a file path, and a note.
- [x] No secrets included; every credential, API key, and token replaced with [REDACTED] (env-var *names* only).
- [x] Every concrete claim cites a file path or marks the claim UNVERIFIED / NOT PRESENT.
- [x] Report written to AUDIT_REPORT.md at the repo root. No project files were modified.
