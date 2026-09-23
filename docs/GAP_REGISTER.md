# GAP REGISTER — the build delta (Stage 1 → full platform)

Measured against the master spec (Section 4), reuse-first. Format: GAP-ID | Title | Priority | Effort | Depends | HF resource | Acceptance | Status.

Status legend: **Working** = ran and observed; **Built (unverified)** = code + tests exist, live provider not yet exercised; **Partial**; **Missing**.

## P0 — no keys needed
- GAP-001 | Artifact auth rendering (image/video display + download) | P0 | S | none | none | images/videos render inline and download with correct name/MIME via authed fetch→blob | **Working** — `MessageList.tsx` `useAuthedUrl`/`downloadArtifact`; videos now play inline via `<video controls>`; backend maps `mp4/webm → kind:'video'` (`agent/artifacts.ts`).
- GAP-002 | Attach-menu consolidation + take-a-screenshot | P0 | S | none | none | exactly one photo/file entry; screenshot capture real or absent; zero duplicates | **Working** — one `+` menu (`Composer.tsx:196-205`), real `getDisplayMedia` capture gated on capability.
- GAP-003 | UI design pass | P0 | L | none | none | axe-core AA, visual review, premium tokens/motion | **Partial** — tokens/motion/reduced-motion/focus rings present; automated axe pass pending.
- GAP-026 | Extension routes re-mounted (skills/plugins/connectors/MCP/custom-tools) | P0 | M | none | none | UI config tabs no longer 410 | **Working** — `routes/agent.ts` management routes + `initAgent()` registry init; `src/routes/__tests__/agentConfig.test.ts` (8 tests) green.

## P1 — provider wiring (endpoints you provision; keys last)
- GAP-004 | Image+text generation (unrestricted FLUX-Kontext/Chroma1-HD) | P1 | M | GAP-001 | dedicated image endpoint | text→image AND reference+text→edit reflecting reference | **Working (live-verified 2026-09-23)** — production E2E: natural-language "Generate an image of a red sports car" → model called `generate_image` itself (no approval pause — media tools now default to `allow`), artifact saved to `/api/files/.../content`. Gradio SSE heartbeat parser fixed + file-download auth on private Spaces + media max-wait budget. Image gen runs on `red-kit/nsfw-media-studio` (Chroma1-HD, A100-large).
- GAP-005 | Video ref2lock (uncensored Wan2.x I2V) | P1 | L | GAP-001, GAP-004 | dedicated/on-demand video endpoint | before/after reference-consistency documented | **Working (live-verified 2026-09-23)** — production E2E: text-only "Make a short video of ocean waves…" → chained `/image_to_video` → mp4 artifact; "Make a short video from this image" + attachment → `/generate_video` with the attached image as start frame → mp4 artifact. Space-side fixes committed to the Space repo: WAN `cross_attention_kwargs`→`attention_kwargs`; A100 fallback (int8 dynamic-activation for the dual 14B transformers when FP8/AOTI sm120 is unavailable); vendored RIFE flownet now cast to cuda+half (its `device()` omits `.half()`); `/generate_video` returns a single Video via a `generate_video_api` wrapper (tuple return crashed Gradio postprocess). Reference **video** (video→video restyle) is not supported by this pipeline — reference **image** is.
- GAP-006 | Prompt auto-optimizer (per-modality, toggle-reveal) | P1 | M | none | fast-tier endpoint | invisible by default; raw retained; toggle shows enhanced | **Working (unit)** — `services/promptOptimizer.ts` per-modality; chat stores raw + sends enhanced and returns `metadata.prompt`; UI toggle in `MessageList.tsx`; image/video tools optimize their own prompt. Tests green.
- GAP-007 | Embeddings+reranker (+ vector retrieval) | P1 | M | migration | embeddings endpoint | reranked cited retrieval | **Built (unverified)** — `services/embeddingStore.ts` (bge-m3 + bge-reranker-v2-m3), project `search_knowledge` tool; store uses `jsonb` (no pgvector extension).
- GAP-008 | SearXNG Docker Space + search pipeline w/ rerank; fallbacks | P1 | M | GAP-007 | HF Space (create) | cited research run; blocked-engine fallback | **Working (unit)** — `webSearch.ts` order SearXNG → Brave → Tavily → DDG → Bing; candidate rerank via bge-reranker (fail-open); `SEARXNG_URL`/`SEARXNG_TOKEN`. Space template in `deploy/space-searxng/`; deploy pending.
- GAP-009 | OCR · ASR · TTS | P1 | M | none | per-task endpoints | each tool round-trips real input→output | **Built (unverified)** — `ocr` (GOT-OCR2_0), `transcribe` (whisper-large-v3-turbo), `speak` (Kokoro-82M), each with dedicated-endpoint override.
- GAP-010 | Key flips: Stripe payments, email, OAuth | P1 | S | your keys | none | honest 503s → fully live | **Built, gated** (unchanged).

## P2 — the platform
- GAP-011 | Sandbox (Docker+gVisor, caps, egress fence, no host mounts) | P2 | XL | none | none | real isolated code execution | **Working (unit)** — `agent/tools/executeCode.ts`: Docker (`--network none`, memory/cpu/pids caps, `--read-only`+tmpfs) with host-subprocess fallback; scrubbed env; wall-clock kill; file artifacts. Docker detected and used in tests.
- GAP-012 | Agent Computer on sandbox | P2 | M | GAP-011 | none | streamed real output/files | **Built (unverified)** — `execute_code` emits `status` + artifacts; `AgentComputer.tsx` renders the live feed.
- GAP-013 | Connectors/MCP (workspace-scoped, OAuth 2.1+PKCE, approval cards, SSRF, ≥3 real) | P2 | XL | vault | none | tool discovery + live approval flow | **Built (unit)** — GitHub + HTTP + catalog adapters, Notion/GitLab reviewed adapters, real MCP client (stdio + StreamableHTTP), OAuth 2.1+PKCE, approval card pauses the stream; per-tool permission levels (allow/approval/blocked) enforced in the loop + a bounded tool-call audit log (`GET /api/agent/audit`, Settings → Tools).
- GAP-014 | Skills (SKILL.md, enable/disable, progressive disclosure, versioning) | P2 | M | GAP-011 | none | one skill end-to-end | **Working** — `skillLoader` (SKILL.md + YAML frontmatter, the Anthropic open standard) + config routes (list/create/**GET detail w/ raw source**/**PUT update**/toggle/delete) + enabled skills injected; Settings → Skills card UI with detail view, Edit-source editor, live preview, and the `create_skill` meta-tool for natural-language creation; versioning pending.
- GAP-015 | Plugins (manifest/loader/lifecycle/permissions + example) | P2 | L | GAP-011 | none | one plugin end-to-end | **Built (unit)** — loader with a real `text-utils` plugin; enable/disable route; install/update lifecycle + isolation pending.
- GAP-016 | Agentic tool loop | P2 | XL | GAP-013/014 | both chat endpoints | visible trace + approval gating | **Working** — `agentRuntime.ts`: native + inline calling, parallel calls/turn, `maxSteps`, approval gate incl. **step mode** ("Ask before each action" — `requiresInteractivePause`), trace UI.
- GAP-017 | Multi-agent fleet (Research = first real use) | P2 | XL | GAP-016/018 | both chat endpoints | multi-step cited research, resumable, live subagents | **Partial** — `deepResearch.ts` 5-phase fleet (flagship plan/synthesis, parallel fast sub-agents) with citations; shared scratchpad table pending.
- GAP-018 | Durable task engine | P2 | L | none | none | resumable multi-step run | **Built (unit)** — `ResearchRun` model + migration + `services/researchRuns.ts` (decoupled from the response, persists progress/report, read API). Live DB apply pending.
- GAP-019 | Projects | P2 | L | GAP-007 | none | project-scoped cited chat | **Working (UI)** — schema + routes + `projectId` on conversations + `search_knowledge`; first-class sidebar section, Claude-style cards, dedicated creation flow, knowledge file upload (.txt/.md/.csv client-side parse).
- GAP-020 | Artifacts panel | P2 | L | GAP-001 | none | versioned artifact preview | **Built (unit)** — `ArtifactsPanel` wired into the chat header; version grouping + line-level compare, sandboxed `<iframe srcDoc sandbox>` HTML preview, and view-only public publish/unpublish (`POST/DELETE /api/files/:id/publish`, anonymous `/api/files/public/:token/content`). Restore pending.
- GAP-021 | Memory | P2 | M | fast-tier | none | remember/recall + editing | **Working** — Memory model (now with `source: user|agent`) + `remember` tool (agent-sourced) + context injection gated by `User.memoryEnabled` + `routes/memory.ts` (list/create/edit/delete/reset + `GET/POST /enabled`); Settings → Memory redesigned (toggle, search, per-item edit/delete, source badges, tag groups, empty state).
- GAP-022 | Styles | P2 | M | fast-tier | none | style applied in a response | **Working** — UserStyle + `generate_style` tool + `/api/styles` incl. `POST /from-sample` + injection; Settings → **Personalization** (preset gallery, custom style flow, sample-based creation, voice preferences).
- GAP-027 | Model selector + capability badges | P2 | S | catalog | none | pick tier per turn | **Built (unit)** — `ModelSelector.tsx` reads `/api/models/catalog`; tier sent as `model`; badges (context/tools/vision).

## P3 — deploy & harden
- GAP-023 | Single-GPU consolidation + routing math | P3 | L | all P1 | single HF GPU endpoint | production routing documented | **Missing**.
- GAP-024 | Store builds (EAS signing, listings, Direct) | P3 | M | your dev accounts | none | signed AAB/APK/IPA | **Missing**.
- GAP-025 | Cutover (IaC, backups/restore, monitoring, load, domain/TLS, rotation) | P3 | XL | GAP-023 | none | production cutover with rollback | **Partial** — see the production-readiness evidence below (backups blocked by image; monitoring code-ready, keys pending).
- GAP-028 | pgvector extension (vs jsonb) | P3 | S | none | none | ANN index on knowledge chunks | **Built (unverified)** — migration enables `vector`, adds `embeddingVec vector(1024)` + ivfflat index; ingest mirrors the vector, search uses `<=>` with an in-app cosine fallback (`services/vectorSearch.ts`). Live DB apply pending.

## New environment variables
`SEARXNG_URL`, `SEARXNG_TOKEN`, `SEARCH_RERANK=false`, `SANDBOX_DOCKER` (true|false), `SANDBOX_NETWORK=true`, `SANDBOX_PYTHON`/`SANDBOX_NODE`, `HF_OPTIMIZER_ENDPOINT_URL`/`HF_OPTIMIZER_MODEL`, `AGENT_DATA_DIR`, `AGENT_SKILLS_DIR`.

## Production-readiness pass (2026-09-22) — live evidence, not unit tests

Ground rule per the brief: every claim below has a log line, an HTTP probe, or a
database row behind it. Per-item evidence was captured against
https://loop-gpt.cyou unless noted.

### Auth (brief §1.2)
- **Providers live:** `GET /api/auth/providers` → `{"providers":["google","github"],"password":true,"guest":false}`.
- **Google sign-in initiation:** `GET /api/auth/oauth/google` → 302 to accounts.google.com with the real client id and a signed 10-min state JWT.
- **GitHub sign-in initiation:** `GET /api/auth/oauth/github` → 302 to github.com/login/oauth/authorize with client `Ov23liM1…` and signed state.
- **Console registrations still needed** (manual): the callback URIs in `docs/CONNECTOR_SETUP.md` must be present in the Google Cloud client + GitHub app; then complete one consent each.
- **Session invalidation (NEW):** migration `20260922000000_session_invalidation` (applied, 22/22), `POST /api/auth/reset` stamps `User.sessionInvalidatedAt`, `authenticateToken` rejects pre-reset JWTs; 6 unit tests; fail-open on DB error by design.
- **Email transport:** `RESEND_API_KEY` + `MAIL_FROM` set in production env (minted key `loop-gpt-backend-production`). **BLOCKED:** the Resend account is at its plan's domain limit — `loop-gpt.cyou` cannot be added until the plan is upgraded or a slot is freed (e.g. the failed `xwf-adsgoogle.com`). Signup already fires welcome+verify through the transport; until the domain verifies, sends are logged no-ops (by design).

### Payments (brief §1.3) — Option B, free-only
- `GET /api/billing/config` → `{"enabled":false,"checkoutEnabled":false,"plans":{"pro":false}}` (honest, fail-closed).
- Landing pricing now reads "Free during launch" with a Soon/waitlist Pro card (no purchasable $15 plan); Account page hides Upgrade unless checkout is enabled (pre-existing gate, verified live).
- Dormant-by-decision documented with a 15-minute go-live checklist: `docs/STRIPE_LIVE_CHECKLIST.md`.

### Connectors (brief §1.4, §5.1/5.2) — automated portion
- **Bug found + fixed live:** the rewritten `routes/oauthConnector.ts` had lost `authenticateToken` on `/init/:connectorType` — every connector OAuth start returned 400 since the UX deploy. Fixed, redeployed, verified.
- Google Drive/Gmail/Calendar/Sheets `init` all **PASS** (authorizeUrl with the platform client).
- Figma marketplace `init` without user creds → correct 400 guidance with the developer-console link.
- Per-provider setup guide (incl. Salesforce/Entra specifics): `docs/CONNECTOR_SETUP.md`.
- **Still manual:** the consent-click + a real tool call per provider (needs a human Google/Figma session) — instructions in the guide.

### Backups + monitoring (brief §1.5)
- **PITR blocked by image:** production Postgres runs `postgres:16.10-bookworm`; Railway PITR requires `ghcr.io/railwayapp-templates/postgres-ssl` (or the HA image). Migrating the image is a planned-maintenance restore operation — deliberately NOT done automatically. Until then: enable volume backups from the Railway dashboard.
- **Sentry/PostHog:** both clients already init in code (backend `server.ts`, frontend `Analytics.tsx`); awaiting `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` + `NEXT_PUBLIC_POSTHOG_KEY` from the operator's accounts — set the vars, they activate with zero code changes.
- **Uptime:** recommend a free external monitor on `/healthz` + `/` (UptimeRobot/BetterStack) — needs an operator account.

### Team invite (brief §1.6)
- `ADMIN_INVITE_CODE` generated + set in production env. **E2E PASS with a DB row:** registered a throwaway user → redeemed the code → API returned `{"type":"unlimited","unlimited":true,"plan":"pro"}` → database row verified `unlimited=true, plan='pro'` → user deleted. (The voucher `LOOP-BFMMX-5M3JC` remains the 5-seat team path.)

### Manual verification battery (brief §5.3/5.4/5.5)
- **Step mode — PASS (real model, live SSE):** `stepMode:true` run paused with `pending_approval` for `get_current_time` BEFORE execution; the tool executed only after `POST /approve`; the final answer streamed afterwards. Full pause→approve→execute→answer loop observed.
- **create_skill — PASS (real model):** natural-language request → model invoked `create_skill` → "Pirate Greeter" created with inferred triggers (ahoy, matey, pirate) → listed via `/api/agent/skills` → `GET /api/agent/skills/pirate-greeter` returned the SKILL.md source with frontmatter → deleted.
- **Voice loop:** browser-dependent by design — Chrome/Edge/Safari support the Web Speech dictation (feature-detected; hidden elsewhere), TTS uses `speechSynthesis` with OS voices. Cross-browser matrix (Firefox degradation notes) remains a manual pass; the code degrades gracefully (buttons hidden when unsupported).
