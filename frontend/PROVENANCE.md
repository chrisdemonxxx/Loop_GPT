# Provenance

This frontend originated from the archived `Seentiourcio47/Loop_GPT` repository
(commit 391f131, 2026-08-19, "add railpack config for subdirectory builds"),
the original scratch-built Next.js product UI for Loop GPT. Git history is
preserved in that archived source repository; this directory was imported into
the canonical `chrisdemonxxx/Loop_GPT` monorepo (main branch) as the product
web app, then hardened: memory-only auth token (never localStorage), the
verified `/api/agent/:id/stream` SSE contract with BYOK fields stripped,
hosted-tier model picker, and Claude-era strings rebranded. The former `web/`
Vite foundation remains in-tree as an internal test harness only.
