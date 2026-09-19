# GAP REGISTER — the build delta (Stage 1 → full platform)

Measured against the master spec (Section 4), reuse-first. Format: GAP-ID | Title | Priority | Effort | Depends | HF resource | Acceptance | Status.

## P0 — no keys needed
- GAP-001 | Artifact auth rendering (image/video display + download) | P0 | S | none | none | images/videos render inline and download with correct name/MIME via authed fetch→blob | Broken (fixing now)
- GAP-002 | Attach-menu consolidation + take-a-screenshot | P0 | S | none | none | exactly one photo/file entry; screenshot capture real or absent; zero duplicates | Duplicate (fixing now)
- GAP-003 | UI design pass | P0 | L | none | none | axe-core AA, visual review, premium tokens/motion | Missing

## P1 — provider wiring (endpoints you provision; keys last)
- GAP-004 | Image+text generation (unrestricted FLUX-Kontext; investigate flux-h3-chain) | P1 | M | GAP-001 | dedicated image endpoint | text→image AND reference+text→edit reflecting reference | Missing
- GAP-005 | Video ref2lock (uncensored Wan2.x I2V; extend video schema with referenceImageId[]) | P1 | L | GAP-001, GAP-004 | dedicated/on-demand video endpoint | before/after reference-consistency documented | Missing
- GAP-006 | Backend prompt auto-optimizer (fast-tier, per-modality, cached, toggle-reveal) | P1 | M | none | fast-tier endpoint (live) | optimizer invisible by default; raw retained; toggle shows enhanced | Missing
- GAP-007 | Embeddings+reranker+pgvector (bge-m3 + bge-reranker-v2-m3) | P1 | M | pgvector migration | embeddings endpoint or serverless | reranked cited retrieval | Missing
- GAP-008 | SearXNG Docker Space + search pipeline with rerank; Brave→Tavily fallback | P1 | M | GAP-007 | HF Space (create) | cited research run; blocked-engine fallback | Missing
- GAP-009 | OCR (GOT-OCR2_0) · ASR (whisper-large-v3-turbo) · TTS (Kokoro-82M) | P1 | M | none | per-task endpoints | each tool round-trips real input→output | Missing
- GAP-010 | Key flips: Stripe payments, email, OAuth | P1 | S | your keys | none | honest 503s → fully live | Built, gated

## P2 — the platform
- GAP-011 | Sandbox (Docker+gVisor, caps, egress fence, no host mounts) | P2 | XL | none | none | real isolated code execution | Missing
- GAP-012 | Agent Computer on sandbox | P2 | M | GAP-011 | none | streamed real output/files | Missing
- GAP-013 | Connectors/MCP (workspace-scoped, vault OAuth 2.1+PKCE, approval cards pausing stream, SSRF protection, ≥3 real) | P2 | XL | vault (exists) | none | tool discovery + live approval flow | Missing
- GAP-014 | Skills (SKILL.md, enable/disable, progressive disclosure, versioning) | P2 | M | GAP-011 | none | one skill end-to-end | Missing
- GAP-015 | Plugins (manifest/loader/lifecycle/permissions + one real example) | P2 | L | GAP-011 | none | one plugin end-to-end | Missing
- GAP-016 | Agentic tool loop (native function calling both tiers, parallel tools, budget guards, trace UI, write-approval gating, interrupt/resume) | P2 | XL | GAP-013/014 | both chat endpoints (live) | visible trace + approval gating | Missing
- GAP-017 | Multi-agent fleet (fast-tier subagents, flagship synthesis, shared scratchpad, fleet dashboard; Research mode = first real use) | P2 | XL | GAP-016/018 | both chat endpoints | multi-step cited research, resumable, live subagents | Missing
- GAP-018 | Durable task engine (steps/checkpoints/resume/deadlines beyond video) | P2 | L | none | none | resumable multi-step run | Missing
- GAP-019 | Projects (instructions, knowledge base, retrieval threshold, sharing roles) | P2 | L | GAP-007 | none | project-scoped cited chat | Missing
- GAP-020 | Artifacts panel (sandboxed iframe, strict CSP, separate origin, versioning/diff/restore, publish) | P2 | L | GAP-001 | none | versioned artifact preview | Missing
- GAP-021 | Memory (explicit + nightly synthesized, scoped, editable, incognito excluded) | P2 | M | fast-tier (live) | none | remember/recall + editing works | Missing
- GAP-022 | Styles (presets + generate-from-sample via fast tier) | P2 | M | fast-tier (live) | none | style applied in a response | Missing

## P3 — deploy & harden
- GAP-023 | Single-GPU consolidation + routing math (quantized footprint × precision + KV-cache + concurrency; small tasks to CPU/serverless; explicit if flagship+video can't share one GPU) | P3 | L | all P1 | single HF GPU endpoint | production routing documented | Missing
- GAP-024 | Store builds (EAS signing, Play/App Store listings, Direct builds) | P3 | M | your dev accounts | none | signed AAB/APK/IPA | Missing
- GAP-025 | Cutover (IaC, backups/restore rehearsal, monitoring, capacity/load/abuse, domain/TLS with rollback, credential rotation) | P3 | XL | GAP-023 | none | production cutover with rollback | Missing
